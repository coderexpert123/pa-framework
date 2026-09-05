// WP-B1 (buttons-program design §3.1, 2026-08-24, internal) — poll-loop-level tests for the
// buttons & interactivity wiring in runPollLoop: the injection queue, the callback_query /
// message_reaction branches, and the R1 poll-offset ordering guarantee.
//
// IMPORTANT — process.exit(0) landmine (discovered verifying this file, unrelated to this
// wave): runPollLoop's while(!signal.aborted) loop unconditionally calls process.exit(0)
// once it exits (main.ts, committed 2026-08-18 in 3beddf6 "WP4: non-blocking restart
// detach" — predates and is untouched by this wave). ANY natural loop-exit path (a real
// AbortError `break`, or `signal.aborted` becoming true at the next top-of-loop check)
// reaches that same unconditional exit. Verified by direct repro: a BEFORE/AFTER
// console.error probe around `await runPollLoop(...)` printed BEFORE and never printed
// AFTER — the calling test's own continuation never runs, because the whole node:test
// process dies first. And critically, `process.exit()` called mid-file inside node:test
// silently collapses that file's TAP reporting to a single opaque pass/fail with every
// other test (in that file, or in any file listed AFTER it in the same `node --test a b c`
// invocation) never reported and never run at all.
//
// Consequence: this file has exactly ONE test, and we deliberately do NOT `await
// runPollLoop(...)` to completion inside it. We kick the run off, drive it through several
// iterations via a scripted fetch mock, and poll the mock's own call log (populated
// synchronously as each HTTP call happens, independent of whether the runPollLoop promise
// ever settles) to know when to assert. The mock's terminal response calls
// controller.abort() (matching the existing setupFetchMock() convention in
// poll-loop.test.ts); once that fires, the loop makes no further HTTP calls before it
// dies. This test explicitly waits for that final settlement before returning, so the NEXT
// test file in a combined gate invocation (e.g. telegram-keyboard.test.js) never races a
// still-live background run for `globalThis.fetch` — empirically, splitting this into
// multiple `it()` blocks (even within this same file) reintroduced exactly that race, so
// everything is folded into one continuous run instead.
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop } from '../main.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

type FetchCall = { url: string; body: string };

function jsonOk(result: unknown) {
  const payload = JSON.stringify({ ok: true, result });
  return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
}

async function waitUntil(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 15 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil: timed out waiting for condition');
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}

function makeState(chatId = 123, lastUpdateId = 500): { chat_id: number; last_update_id: number; thread_id: number; turns: unknown[] } {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}

const ALLOWED_CHAT = 123;
const DISALLOWED_CHAT = 999999; // convention used elsewhere in this suite for "disallowed chat"

describe('runPollLoop: buttons & interactivity wiring (WP-B1)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-poll-callbacks-'));
    process.env.PA_HOME = tempDir;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it(
    'cf:y press: answers once, dispatches "yes" on the NEXT iteration via the injection ' +
      'queue, never poisons the real getUpdates offset with the synthetic id, and a ' +
      'message_reaction on a non-allowed chat produces zero attributable HTTP calls (R1, §3.1)',
    async () => {
      // A real (fast) worker so the synthetic "yes" text produces an actual dispatch +
      // sendMessage reply, exactly like poll-loop.test.ts's existing dispatch tests.
      const configPath = join(tempDir, 'config.yaml');
      const succeedScript = join(tempDir, 'succeed-worker.mjs');
      await writeFile(succeedScript, 'process.stdout.write("ok reply"); process.exit(0);\n', 'utf8');
      await writeFile(
        configPath,
        `
workers:
  - name: zclaude
    command: node
    args: ["${succeedScript.replace(/\\/g, '/')}"]
    check: node -e "process.exit(0)"
    rate_limit_patterns: []
topic_defaults:
  "123_0": "zclaude"
`,
        'utf8'
      );

      // Pre-seed an existing pinned status card so the dispatch's post-run status-card
      // logic takes the in-place editMessageText refresh path (or no-ops) instead of
      // posting+pinning a FRESH card via sendMessageWithId — which also POSTs to
      // /sendMessage and would otherwise make the "exactly one sendMessage" assertion
      // below racy (0, 1, or 2 sendMessage calls depending on whether the first-ever-pin
      // path had fired yet when this test checks).
      const topicStateFile = join(tempDir, 'telegram-bot-topic-123_0.json');
      await writeFile(topicStateFile, JSON.stringify({ chat_id: 123, thread_id: 0, turns: [], pinned_status_message_id: 42 }), 'utf8');

      const controller = new AbortController();
      const state = makeState(ALLOWED_CHAT, 500);

      const cbUpdate = {
        update_id: 501,
        callback_query: {
          id: 'cbq-1',
          from: { id: 111, first_name: 'Tester' },
          message: { message_id: 50, chat: { id: ALLOWED_CHAT, type: 'private' }, date: Math.floor(Date.now() / 1000), text: 'Proceed?' },
          data: 'cf:y',
        },
      };
      const reactionUpdate = {
        update_id: 502,
        message_reaction: {
          chat: { id: DISALLOWED_CHAT, type: 'private' },
          message_id: 60,
          date: Math.floor(Date.now() / 1000),
          old_reaction: [],
          new_reaction: [{ type: 'emoji', emoji: '👍' }],
        },
      };

      const calls: FetchCall[] = [];
      let getUpdatesCount = 0;
      // Iteration schedule: 1 = the cf:y press; 2 = empty real batch (drains the injected
      // synthetic "yes"); 3 = the disallowed-chat reaction (real, but filtered before any
      // handler runs); 4+ = empty, and this is where we abort — nothing left to do.
      const TERMINAL_ITERATION = 4;

      (globalThis as Record<string, unknown>).fetch = async (url: string, init?: { body?: string }) => {
        calls.push({ url: String(url), body: init?.body ? String(init.body) : '' });
        if (String(url).includes('getUpdates')) {
          getUpdatesCount++;
          if (getUpdatesCount === 1) return jsonOk([cbUpdate]);
          if (getUpdatesCount === 2) return jsonOk([]);
          if (getUpdatesCount === 3) return jsonOk([reactionUpdate]);
          controller.abort();
          return jsonOk([]);
        }
        if (String(url).includes('/sendMessage')) {
          return jsonOk({ message_id: 900 });
        }
        // answerCallbackQuery, editMessageReplyMarkup, sendChatAction, pinChatMessage, etc.
        return jsonOk(true);
      };

      // Deliberately NOT awaited to completion — see the file header comment. Also deliberately
      // NOT latched (trackPendingWork): the loop dies via the REAL process.exit(0) before afterEach
      // runs, so a held latch only hands that exit the window to darken the file mid-TAP.
      runPollLoop('token', [ALLOWED_CHAT], state, {}, controller.signal, async () => {}).catch(() => {});

      // The cf:y press has been answered, and the resulting synthetic "yes" has been
      // dispatched to a real worker, producing exactly one sendMessage — on the NEXT
      // iteration, per §3.1's injection-queue design.
      await waitUntil(() => calls.some((c) => c.url.includes('/sendMessage')));

      const answerCalls = calls.filter((c) => c.url.includes('/answerCallbackQuery'));
      assert.equal(answerCalls.length, 1, 'exactly one answerCallbackQuery POST for the cf:y press');

      const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
      assert.equal(sendCalls.length, 1, 'exactly one sendMessage POST for the resulting dispatch, on the next iteration');

      // R1: getUpdates must never be called with an offset above the real batch's last
      // update_id. The bound below catches a synthetic-id-POISONED offset
      // (nextSyntheticUpdateId() returns something ~1.7e12, always >= Date.now()) — it does
      // not pin an exact small number, since the background run may already have advanced
      // a little further (up through the disallowed-chat reaction, update_id 502) by the
      // time this poll wakes up.
      let getUpdatesCalls = calls.filter((c) => c.url.includes('getUpdates'));
      assert.ok(getUpdatesCalls.length >= 2, 'must have polled at least twice by this point');
      for (const c of getUpdatesCalls) {
        const offsetMatch = c.url.match(/[?&]offset=(-?\d+)/);
        assert.ok(offsetMatch, `getUpdates URL must carry an offset: ${c.url}`);
        const offset = Number(offsetMatch![1]);
        assert.ok(offset < 100_000, `getUpdates offset must stay near the real update_id stream, got ${offset} (a synthetic-id-poisoned offset would be ~1.7e12)`);
      }

      // allowed_updates must carry all three members on every getUpdates call (P1b / R4).
      for (const c of getUpdatesCalls) {
        const decoded = decodeURIComponent(c.url.split('allowed_updates=')[1] ?? '');
        const parsed = JSON.parse(decoded);
        assert.deepEqual(
          new Set(parsed),
          new Set(['message', 'callback_query', 'message_reaction']),
          `allowed_updates must carry all three members: ${c.url}`
        );
      }

      // The drained synthetic update (iteration 2) must NOT have advanced
      // state.last_update_id — it only ever comes from the REAL getUpdates batch, and the
      // real batch it rode along with (iteration 2) was empty. The value must be one of the
      // REAL update_ids seen so far (501, or 502 once the reaction update has also landed),
      // never the synthetic's own huge id.
      assert.ok(
        state.last_update_id === 501 || state.last_update_id === 502,
        `a drained synthetic update must never advance state.last_update_id to anything but a real update_id; got ${state.last_update_id}`
      );

      // Wait for the whole run to fully settle (4th getUpdates call, which triggers
      // controller.abort()) before asserting on the disallowed-chat reaction and before
      // this test returns. Without waiting here, the background run could still be alive
      // when the NEXT test file's beforeEach swaps in a fresh globalThis.fetch mock,
      // corrupting that other mock's call count/sequencing — confirmed empirically.
      await waitUntil(() => calls.filter((c) => c.url.includes('getUpdates')).length >= TERMINAL_ITERATION);

      // A message_reaction on a chat that is not in allowedChatIds must produce no calls
      // attributable to it at all: no outbound call body may ever mention that chat id.
      const disallowedChatCalls = calls.filter((c) => c.body.includes(String(DISALLOWED_CHAT)));
      assert.equal(disallowedChatCalls.length, 0, 'the disallowed-chat reaction must never appear in any outbound call body');

      getUpdatesCalls = calls.filter((c) => c.url.includes('getUpdates'));
      assert.equal(getUpdatesCalls.length, TERMINAL_ITERATION, 'exactly the scripted number of poll iterations ran — nothing kept polling after the abort');
    }
  );
});
