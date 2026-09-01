/**
 * worker-edit-audit-wiring.test.ts — AI-173 phase 1 / absorbed AI-175 WP-3
 * (2026-09-01).
 *
 * Verifies main.ts opens/closes a worker-edit-audit window around the
 * dispatch path (openWindow before the try whose finally clears
 * typingInterval; closeWindow in that same finally). processUpdate is not
 * exported (spec correction C6), so these tests drive runPollLoop with a
 * text-only update and inspect PA_HOME/worker-edit-audit/ for leftover
 * window files rather than calling processUpdate directly.
 *
 * Harness conventions copied from voice-poll-loop.test.ts: makeState(),
 * fastSleep, a URL-aware fetch mock, mkdtemp + PA_HOME, rmRetry cleanup,
 * waitForDrain() in afterEach.
 *
 * Spec: plans/2026-09-01-ai173-phase1-attachment-stage-SPEC.md §6 (B-T1..B-T4).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop, _setExitForTest } from '../main.js';
import type { ConversationState } from '../types.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';

// Root cause of a file like this registering ZERO tests under `node --test`
// (AI-171): each awaited runPollLoop() below runs its loop to completion and
// hits the real process.exit(0), killing this file's isolated test subprocess
// before its TAP output reaches the parent.
_setExitForTest(() => {});

function makeState(chatId = 123, lastUpdateId = -1): ConversationState {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] } as any;
}

// Instant sleep for tests — no real waiting between poll iterations.
const fastSleep = async (_ms: number): Promise<void> => {};

// sendMessage runs every reply through sanitizeMdV2 (backslash-escapes
// MarkdownV2 specials) before JSON-encoding it into the request body.
function unescapedBody(body: unknown): string {
  return String(body ?? '').replace(/\\+/g, '');
}

// Every sent reply carries a freshly minted, random ref-ID line, a live
// wall-clock timestamp (buildPrompt's "Current time (IST): ..."), and a
// mkdtemp-generated temp-dir name embedded in the topic workspace path —
// none of those are the audit's doing. Normalize them away so an audit-on
// and an audit-off run of the "same scenario" (B-T4) can be compared for
// equality without false positives from per-run incidentals.
function stripIncidentals(text: string): string {
  return text
    .replace(/_Ref: [a-zA-Z]+-[0-9a-f]+_/g, '_Ref: <redacted>_')
    .replace(/Current time \(IST\): \S+/g, 'Current time (IST): <redacted>')
    .replace(/tgbot-audit-wiring-[A-Za-z0-9]+/g, 'tgbot-audit-wiring-<redacted>');
}

function jsonResponse(obj: unknown) {
  const text = JSON.stringify(obj);
  return { ok: true, status: 200, text: async () => text, json: async () => obj };
}

function textUpdate(updateId: number, text: string, messageId?: number) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId ?? updateId,
      chat: { id: 123, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function setupTextFetchMock(opts: { batches: any[][]; controller: AbortController }): Array<{ url: string; body?: string }> {
  const calls: Array<{ url: string; body?: string }> = [];
  let batchIndex = 0;

  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: any) => {
    calls.push({ url, body: init?.body });
    if (url.includes('getUpdates')) {
      const batch = opts.batches[batchIndex] ?? [];
      batchIndex++;
      if (batchIndex >= opts.batches.length) opts.controller.abort();
      return jsonResponse({ ok: true, result: batch });
    }
    return jsonResponse({ ok: true, result: { message_id: 900 + calls.length } });
  };

  return calls;
}

async function writeEchoWorkerConfig(tempDir: string): Promise<void> {
  const scriptPath = join(tempDir, 'echo-worker.mjs');
  await writeFile(
    scriptPath,
    "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);" +
      "process.stdin.on('end',()=>{process.stdout.write('WORKER_ECHO:'+d);process.exit(0);});\n",
    'utf8',
  );
  const posixScriptPath = scriptPath.replace(/\\/g, '/');
  await writeFile(
    join(tempDir, 'config.yaml'),
    `
workers:
  - name: claude
    command: node
    args: ["${posixScriptPath}"]
    check: node -e "process.exit(0)"
    input_mode: stdin-text
topic_defaults:
  "123_0": "claude"
`,
    'utf8',
  );
}

// B-T3: a worker config pointing at a command that does not exist. `check`
// still passes trivially so runWithFailover actually attempts the dispatch
// (rather than skipping it as unhealthy), and the spawn itself fails.
async function writeBrokenWorkerConfig(tempDir: string): Promise<void> {
  await writeFile(
    join(tempDir, 'config.yaml'),
    `
workers:
  - name: claude
    command: this-command-does-not-exist-xyz-12345
    args: []
    check: node -e "process.exit(0)"
    input_mode: stdin-text
topic_defaults:
  "123_0": "claude"
`,
    'utf8',
  );
}

async function listWindowFiles(paHome: string): Promise<string[]> {
  try {
    const entries = await readdir(join(paHome, 'worker-edit-audit'));
    return entries.filter((f) => f.endsWith('.json'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

describe('worker-edit-audit wiring (AI-173 phase 1 / AI-175 WP-3)', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  let savedAudit: string | undefined;

  // B-T4 compares the bodies B-T1 and B-T2 captured for the identical
  // scenario (same chatId/updateId/messageId/text) rather than paying for a
  // third real-git dispatch of its own — §6's note bounds the real
  // `defaultGitRunner` cost to B-T2/B-T3.
  let auditOffBodies: string[] | undefined;
  let auditOnBodies: string[] | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-audit-wiring-'));
    process.env.PA_HOME = tempDir;
    savedAudit = process.env.PA_WORKER_EDIT_AUDIT;
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    if (savedAudit === undefined) delete process.env.PA_WORKER_EDIT_AUDIT;
    else process.env.PA_WORKER_EDIT_AUDIT = savedAudit;
    await rmRetry(tempDir);
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('B-T1: PA_WORKER_EDIT_AUDIT=0, one text dispatch — no window files, reply sent', async () => {
    process.env.PA_WORKER_EDIT_AUDIT = '0';
    await writeEchoWorkerConfig(tempDir);
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = textUpdate(1, 'hello there', 1);
    const calls = setupTextFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const windowFiles = await listWindowFiles(tempDir);
    assert.deepEqual(windowFiles, [], 'no *.json under <PA_HOME>/worker-edit-audit/ (the directory may legitimately not exist)');

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(sendCalls.some((c) => unescapedBody(c.body).includes('WORKER_ECHO:')), 'the worker reply should have been sent');
    auditOffBodies = sendCalls.map((c) => stripIncidentals(unescapedBody(c.body)));
  });

  it('B-T2: PA_WORKER_EDIT_AUDIT=1, one successful text dispatch — window opened AND closed', async () => {
    process.env.PA_WORKER_EDIT_AUDIT = '1';
    await writeEchoWorkerConfig(tempDir);
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = textUpdate(1, 'hello there', 1);
    const calls = setupTextFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const windowFiles = await listWindowFiles(tempDir);
    assert.deepEqual(windowFiles, [], 'after runPollLoop resolves the window file must be gone — opened AND closed');

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(sendCalls.some((c) => unescapedBody(c.body).includes('WORKER_ECHO:')), 'the worker reply should still have been sent');
    auditOnBodies = sendCalls.map((c) => stripIncidentals(unescapedBody(c.body)));
  });

  it('B-T3: PA_WORKER_EDIT_AUDIT=1, worker config points at a non-existent command — window still closed, error reply sent', async () => {
    process.env.PA_WORKER_EDIT_AUDIT = '1';
    await writeBrokenWorkerConfig(tempDir);
    const controller = new AbortController();
    const state = makeState(123, -1);
    const update = textUpdate(2, 'hello there', 2);
    const calls = setupTextFetchMock({ batches: [[update], []], controller });

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep);

    const windowFiles = await listWindowFiles(tempDir);
    assert.deepEqual(windowFiles, [], 'the finally must close the window even on the failure path');

    const sendCalls = calls.filter((c) => c.url.includes('/sendMessage'));
    assert.ok(sendCalls.length > 0, 'an error reply should still have been sent');
  });

  it('B-T4: audit on vs audit off produce the identical set of user-visible /sendMessage bodies', () => {
    assert.ok(auditOffBodies, 'B-T1 must have run before B-T4 and captured its send bodies');
    assert.ok(auditOnBodies, 'B-T2 must have run before B-T4 and captured its send bodies');
    assert.deepEqual(auditOnBodies, auditOffBodies, 'the audit must not change any user-visible reply');
  });
});
