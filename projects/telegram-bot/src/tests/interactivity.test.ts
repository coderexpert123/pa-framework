// WP-D1 bot-side interactivity conversions (SPEC §3.4-D1, plans/2026-09-02-topic-handover-WAVE2-SPEC.md;
// interactivity-audit A.1-A.3): A.1 the topic-description accept/skip ask carries the
// cf: yes/no keyboard (a press injects the typed yes/no that resolvePendingDescription
// consumes — §1.5, zero new grammar); A.2 the pinned-worker spawn-failure hint's reply
// carries wf:switch naming the suggested alternate; A.3 the empty-output error reply
// carries wf:switch naming dispatchMessage's threaded suggestedWorker. The reply-send
// cascade priority (failover > confirm > question) is re-pinned against the new next:.
// MUST stay first — sandboxes PA_HOME against real side effects (test-env-guard contract).
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { _setExitForTest, postDescriptionSuggestion, runPollLoop } from '../main.js';
import { resolvePendingDescription } from '../logic.js';
import { parseCallbackData, syntheticTextFor, handleCallbackQuery, type CallbackDeps } from '../callbacks.js';
import { loadTopicState } from '../conversation.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import { waitForDrain } from './test-teardown-guard.js';
import { rmRetry } from './rm-retry.js';

// Integration cases below await runPollLoop() to completion — without this no-op the
// loop's terminal process.exit(0) kills this file's test subprocess before TAP
// flushes and the file reads back DARK (AI-171 root cause).
_setExitForTest(() => {});

const fastSleep = async (_ms: number): Promise<void> => {};

function makeUpdate(updateId: number, chatId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function ok(body: unknown) {
  // json() must return the OBJECT — telegram.ts's getUpdates reads res.json().result;
  // a stringified body parses as a string there and every batch silently reads empty.
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

/** Multi-batch getUpdates + send-capturing fetch stub (topic-tasks-drain harness shape). */
function setupFetch(controller: AbortController, batches: object[][]) {
  const savedFetch = globalThis.fetch;
  const sends: any[] = [];
  let batchIndex = 0;
  (globalThis as Record<string, unknown>).fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('getUpdates')) {
      const result = batches[batchIndex] ?? [];
      if (batchIndex >= batches.length - 1) controller.abort();
      batchIndex++;
      return ok({ ok: true, result });
    }
    if (u.includes('sendMessage')) {
      try { sends.push(JSON.parse(String(init?.body ?? '{}'))); } catch { sends.push({}); }
      return ok({ ok: true, result: { message_id: 999 } });
    }
    return ok({ ok: true, result: true });
  });
  return { sends, restore: () => { (globalThis as Record<string, unknown>).fetch = savedFetch; } };
}

function keyboardsOf(body: any): Array<Array<{ text: string; callback_data: string }>> {
  const rm = body?.reply_markup;
  const kb = typeof rm === 'string' ? JSON.parse(rm) : rm;
  return kb?.inline_keyboard ?? [];
}

/** Exactly-one reply filter — the pinned status card send also carries a keyboard,
 *  so "any send with a keyboard" is not a usable discriminator. Failure output lists
 *  what WAS sent, so a mis-routed dispatch is diagnosable from the log alone. */
function replyByText(sends: any[], needle: string): any {
  const replies = sends.filter((s) => typeof s.text === 'string' && s.text.includes(needle));
  assert.equal(
    replies.length, 1,
    `expected exactly one reply containing "${needle}", got ${replies.length}; sends were: ${
      sends.map((s) => String(s.text ?? '').slice(0, 90)).join(' | ') || '(none)'
    }`,
  );
  return replies[0];
}

function callbackDataOf(reply: any): string[] {
  return keyboardsOf(reply).flat().map((b) => b.callback_data);
}

describe('WP-D1: description ask carries the cf: keyboard (A.1)', () => {
  let tempDir: string;
  let restoreFetch: (() => void) | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'wpd1-desc-'));
    process.env.PA_HOME = tempDir;
    process.env.PA_NOTIFY_DISABLED = '1';
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    await flushLog();
    await waitForDrain();
    delete process.env.PA_HOME;
    delete process.env.PA_NOTIFY_DISABLED;
    await rmRetry(tempDir);
  });

  it('description ask carries confirm keyboard', async () => {
    const savedFetch = globalThis.fetch;
    const sends: any[] = [];
    (globalThis as Record<string, unknown>).fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('sendMessage')) {
        try { sends.push(JSON.parse(String(init?.body ?? '{}'))); } catch { sends.push({}); }
      }
      return ok({ ok: true, result: { message_id: 1 } });
    });
    restoreFetch = () => { (globalThis as Record<string, unknown>).fetch = savedFetch; };

    await postDescriptionSuggestion('token', 123, 0, 'AI topic description', 'test');

    const ask = replyByText(sends, 'Suggested description');
    assert.deepEqual(
      keyboardsOf(ask),
      [[
        { text: '✅ Yes', callback_data: 'cf:y' },
        { text: '❌ No', callback_data: 'cf:n' },
      ]],
      'the accept/skip ask must carry the cf: yes/no keyboard',
    );
    // The ask is still backed by the durable pendingDescription state.
    const state = await loadTopicState(123, 0);
    assert.equal(state.pendingDescription?.text, 'AI topic description');
  });

  it('cf press resolves the description suggestion', async () => {
    const savedFetch = globalThis.fetch;
    (globalThis as Record<string, unknown>).fetch = (async () => ok({ ok: true, result: { message_id: 555 } }));
    restoreFetch = () => { (globalThis as Record<string, unknown>).fetch = savedFetch; };

    // Arm through the REAL producer (state file + keyboard render).
    await postDescriptionSuggestion('token', 123, 0, 'AI topic description', 'test');

    // The keyboard's own callback_data through the REAL parser and the REAL
    // press handler — the injection is exactly what a live press does.
    const parsed = parseCallbackData('cf:y');
    assert.ok(parsed, 'cf:y must parse');
    assert.equal(syntheticTextFor(parsed), 'yes', 'the press injects the typed word');

    const injected: any[] = [];
    const deps: CallbackDeps = {
      token: 'token',
      secrets: {},
      runtimeEnv: {},
      botCwd: tempDir,
      spawnReauthLink: () => 'reauth',
      injectUpdate: (u) => injected.push(u),
      loadTopicState,
      listWorkerNames: async () => [],
      observedValues: async () => [],
      declaredValues: async () => [],
      effectiveDefaultWorker: async () => 'claude',
      loadRunningTasks: async () => [],
    };
    const cb = {
      id: 'cb1',
      from: { id: 77, is_bot: false, first_name: 'Operator' },
      data: 'cf:y',
      message: {
        message_id: 555,
        message_thread_id: 0,
        chat: { id: 123, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text: 'Suggested description',
      },
    } as any;
    assert.equal(await handleCallbackQuery(cb, deps), 'cf:y');
    assert.equal(injected.length, 1, 'press must inject exactly one synthetic turn');
    const injectedText = injected[0]?.message?.text;
    assert.equal(injectedText, 'yes');

    // REAL consumer over the state the producer armed: the injected typed word is
    // what resolvePendingDescription eats.
    const state = await loadTopicState(123, 0);
    const resolved = resolvePendingDescription(state, injectedText, { voiceTranscribed: false });
    assert.equal(resolved.skipWorker, true);
    assert.equal(resolved.response, 'Description set.');
    assert.equal(resolved.acceptDescriptionText, 'AI topic description');
    assert.equal(state.pendingDescription, undefined, 'pendingDescription must clear on accept');
  });
});

describe('WP-D1: worker-error replies offer the switch they name (A.2/A.3)', () => {
  let tempDir: string;
  let restoreFetch: (() => void) | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'wpd1-kb-'));
    process.env.PA_HOME = tempDir;
    process.env.PA_NOTIFY_DISABLED = '1';
    await writeFile(join(tempDir, 'blackboard.json'), JSON.stringify({ active_locks: [] }), 'utf8');
    await writeFile(join(tempDir, 'rate-limit-state.json'), '{}', 'utf8');
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = undefined;
    await flushLog();
    await waitForDrain();
    delete process.env.PA_HOME;
    delete process.env.PA_NOTIFY_DISABLED;
    await rmRetry(tempDir);
  });

  /** The dispatch-error fixture vocabulary (dispatch-error-paths.test.ts shape). */
  function writeWorkerConfig(): Promise<void> {
    return writeFile(join(tempDir, 'config.yaml'), JSON.stringify({
      workers: [
        { name: 'zclaude', command: 'node', args: ['-e', 'process.exitCode=0'], check: 'echo ok', input_mode: 'stdin-text', output_format: 'text', rate_limit_patterns: [], priority: 1, state_dir: '/nonexistent', state_pattern: '*.jsonl' },
        { name: 'agy', command: 'node', args: ['-e', 'process.exitCode=1'], check: 'echo ok', input_mode: 'stdin-text', output_format: 'text', rate_limit_patterns: [], priority: 2, state_dir: '/nonexistent', state_pattern: '*.jsonl' },
      ],
    }), 'utf8');
  }

  it('pinned-worker hint reply offers switch to alternate', async () => {
    // No config.yaml: dispatchMessage's unguarded loadConfig() throws
    // "Config not found ..." — a spawn-failed-class message into processUpdate's
    // catch path. Seeded preferred_worker makes the failure pinned, and
    // resolveEffectiveDefaultWorker's fallback ('claude') gives
    // findNextAvailableWorker a REAL alternate via its defaultWorker branch.
    await writeFile(join(tempDir, 'telegram-bot-topic-123_0.json'), JSON.stringify({
      chat_id: 123, thread_id: 0, turns: [], preferred_worker: 'zclaude',
    }), 'utf8');
    const controller = new AbortController();
    // Trailing empty batch: the harness aborts while SERVING the last batch, so the
    // final batch's updates would be discarded unprocessed — every batch that must be
    // processed needs an empty batch after it (topic-tasks-drain [[...], []] shape).
    const { sends, restore } = setupFetch(controller, [
      [makeUpdate(11, 123, 'hello')],
      [makeUpdate(12, 123, 'hello')],
      [],
    ]);
    restoreFetch = restore;

    await runPollLoop('token', [123], { chat_id: 123, last_update_id: -1, thread_id: 0, turns: [] }, {}, controller.signal, fastSleep);

    // The hint is rate-limited to the SECOND consecutive spawn-class failure.
    const hinted = replyByText(sends, 'is failing');
    assert.ok(String(hinted.text).includes('Pinned worker zclaude is failing'), 'hint names the pinned worker');
    const data = callbackDataOf(hinted);
    assert.ok(data.includes('wf:retry'), 'hint reply keeps the retry button');
    assert.ok(
      data.includes('wf:switch:claude'),
      `hint reply must offer the suggested alternate, got [${data.join(', ')}]`,
    );
  });

  it('empty-response reply offers switch to suggested worker', async () => {
    await writeWorkerConfig();
    const controller = new AbortController();
    // Trailing empty batch — see the hint test above.
    const { sends, restore } = setupFetch(controller, [[makeUpdate(21, 124, 'hello')], []]);
    restoreFetch = restore;

    await runPollLoop('token', [124], { chat_id: 124, last_update_id: -1, thread_id: 0, turns: [] }, {}, controller.signal, fastSleep);

    // zclaude succeeds with empty output → the empty-output error reply, whose
    // suggestedWorker (agy, the only other configured worker) must surface as a
    // wf:switch button on that same reply.
    const reply = replyByText(sends, 'empty response');
    const data = callbackDataOf(reply);
    assert.ok(data.includes('wf:retry'), 'error reply keeps the retry button');
    assert.ok(
      data.includes('wf:switch:agy'),
      `error reply must offer dispatchMessage's suggested worker, got [${data.join(', ')}]`,
    );
  });

  it('failover keyboard still wins the cascade', async () => {
    await writeWorkerConfig();
    await writeFile(join(tempDir, 'telegram-bot-topic-125_0.json'), JSON.stringify({
      chat_id: 125, thread_id: 0, turns: [],
      pending_action: { description: 'do the thing', proposed_at: new Date().toISOString() },
      pending_question: { text: 'Prefer A or B?', options: ['Option A', 'Option B'], asked_at: new Date().toISOString() },
    }), 'utf8');
    const controller = new AbortController();
    // Trailing empty batch — see the hint test above.
    const { sends, restore } = setupFetch(controller, [[makeUpdate(31, 125, 'hello')], []]);
    restoreFetch = restore;

    await runPollLoop('token', [125], { chat_id: 125, last_update_id: -1, thread_id: 0, turns: [] }, {}, controller.signal, fastSleep);

    // A confirmed pending_action AND a fresh pending_question are both armed, but
    // the dispatch errored — the failover keyboard must displace both.
    const reply = replyByText(sends, 'empty response');
    const data = callbackDataOf(reply);
    assert.ok(data.includes('wf:retry'), 'failover keyboard attached');
    assert.ok(!data.some((d) => d.startsWith('cf:')), 'confirm keyboard must NOT displace the failover keyboard');
    assert.ok(!data.some((d) => d.startsWith('q:')), 'question keyboard must NOT displace the failover keyboard');
  });
});
