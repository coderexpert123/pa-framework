import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'fs/promises';
import { rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runPollLoop, _setExitForTest } from '../main.js';
import type { TopicNameMap } from '../topic-names.js';
import { rmRetry } from './rm-retry.js';
import { waitForDrain } from './test-teardown-guard.js';
import { logger } from '../../../../pa/dist/src/lib/log.js';

// See poll-loop.test.ts's own note: `node --test` isolates this file into its
// own subprocess, and runPollLoop's natural exit path calls the real
// process.exit(0), which would kill the subprocess before its TAP output
// reaches the parent. Neutralize it for the life of this subprocess.
_setExitForTest(() => {});

const fastSleep = async (_ms: number): Promise<void> => {};

function makeState(chatId = 123, lastUpdateId = -1) {
  return { chat_id: chatId, last_update_id: lastUpdateId, thread_id: 0, turns: [] };
}

// ---------------------------------------------------------------------------
// Regression test for the branchCreatedTopicKeys registration-timing fix.
//
// processUpdate's /branch handler creates a forum topic, then (in the fixed
// version) registers `${chatId}_${newThreadId}` in branchCreatedTopicKeys
// SYNCHRONOUSLY right after createForumTopic resolves, before any further
// await. The concurrent forum_topic_created service-message update (which
// Telegram delivers via a separate getUpdates batch) checks that set via
// branchCreatedTopicKeys.delete(topicKey) to decide whether to auto-generate
// and overwrite the topic description. If registration happens too late
// (after the /branch handler's own LLM description call and topic-state
// saves, as it did before the fix), the race lets forum_topic_created's
// auto-description win and overwrite the branch's real description.
//
// generateDescriptionWithLLM defaults to spawning the `claude` binary via
// execFile when no runner is injected (processUpdate does not inject one).
// CLAUDE_CMD is pointed at a command that cannot exist, so that call fails
// fast (ENOENT) instead of making a real, slow LLM call — both the /branch
// handler's own description call and forum_topic_created's auto-description
// call take this fast-failure path, and both fall back to their deterministic
// non-LLM description strings, which is exactly what this test discriminates
// on.
// ---------------------------------------------------------------------------

describe('runPollLoop: branch topic description survives the forum_topic_created race', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedClaudeCmd = process.env.CLAUDE_CMD;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-branch-race-'));
    process.env.PA_HOME = tempDir;
    process.env.CLAUDE_CMD = 'pa-test-nonexistent-claude-binary-xyz';
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    if (savedClaudeCmd === undefined) delete process.env.CLAUDE_CMD;
    else process.env.CLAUDE_CMD = savedClaudeCmd;
    (globalThis as Record<string, unknown>).fetch = savedFetch;
  });

  it('the branch description is not overwritten by the auto-description path', async () => {
    const controller = new AbortController();
    const state = makeState(123, -1);
    const topicNames: TopicNameMap = new Map();
    let getUpdatesCount = 0;
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => { gateResolve = r; });

    const branchUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: '/branch test-race some purpose',
        message_thread_id: undefined as number | undefined,
      },
    };
    const ftcUpdate = {
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 123, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 999,
        forum_topic_created: { name: 'test-race', icon_color: 0 },
      },
    };

    (globalThis as Record<string, unknown>).fetch = async (url: string, _opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [branchUpdate] }), json: async () => ({ ok: true, result: [branchUpdate] }) };
        }
        if (getUpdatesCount === 2) {
          // Wait until createForumTopic has resolved in the /branch handler
          // before delivering the forum_topic_created update, mirroring the
          // production race: the two updates arrive on separate poll
          // batches and are dispatched concurrently (different topic keys).
          await gate;
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [ftcUpdate] }), json: async () => ({ ok: true, result: [ftcUpdate] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('createForumTopic')) {
        gateResolve();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_thread_id: 999 } }), json: async () => ({ ok: true, result: { message_thread_id: 999 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }), json: async () => ({ ok: true, result: { message_id: 99 } }) };
    };

    await runPollLoop('token', [123], state, {}, controller.signal, fastSleep, undefined, topicNames, new Map());

    const entry = topicNames.get('123')?.get(999);
    assert.ok(entry, 'topic 999 must have a registered name/description entry');
    // The /branch handler's own fallback description (LLM call fails fast via
    // the bogus CLAUDE_CMD) is "Branch of <parent> for test-race: some purpose."
    // forum_topic_created's auto-description fallback (also an LLM-failure
    // fallback) is "Discussions and tasks relating to test-race." — a
    // different, generic string. If the race wins, the branch description is
    // clobbered by the generic one.
    assert.ok(
      entry!.description?.includes('Branch of'),
      `branch description must survive; got: ${JSON.stringify(entry?.description)}`
    );
    assert.ok(
      !entry!.description?.includes('Discussions and tasks relating to'),
      `branch description must not be overwritten by the generic auto-description; got: ${JSON.stringify(entry?.description)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Regression test for the catch path around branchCreatedTopicKeys (commit
// 5180987): the /branch handler's try/catch around the topic-setup span
// (updateTopicName ... setTopicDescription) does
//   branchCreatedTopicKeys.delete(branchCreatedKey); throw err;
// on failure. This exercises that catch path directly: it forces the very
// first await inside the try (updateTopicName's underlying saveTopicNames
// write) to reject, then asserts (1) the rejection is not swallowed — it
// propagates out of processUpdate to the poll loop's own rejection handler
// — and (2) the provisional key was removed, so a later forum_topic_created
// event for the same topic is NOT wrongly treated as "already described" and
// still gets its fallback description.
//
// The failure is induced by pre-creating a directory at the exact `.tmp`
// path saveTopicNames writes to (`<PA_HOME>/telegram-topic-names.json.tmp`),
// which makes fs.writeFile reject with EISDIR instead of succeeding — no
// change to topic-names.ts or main.ts is needed. The block is removed again
// (in the logger.warn spy, once the propagated rejection is observed) so the
// later forum_topic_created update's own updateTopicName/setTopicDescription
// calls persist normally and the fallback description is actually visible
// to assert on, rather than also failing.
// ---------------------------------------------------------------------------

describe('runPollLoop: branch topic setup failure removes the provisional key', { concurrency: 1 }, () => {
  let tempDir: string;
  const savedFetch = globalThis.fetch;
  const savedClaudeCmd = process.env.CLAUDE_CMD;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tgbot-branch-catch-'));
    process.env.PA_HOME = tempDir;
    process.env.CLAUDE_CMD = 'pa-test-nonexistent-claude-binary-xyz';
    // Block the atomic-write tmp path so the FIRST saveTopicNames call
    // (invoked by updateTopicName, the first await inside the /branch
    // handler's try block) rejects with EISDIR.
    await mkdir(join(tempDir, 'telegram-topic-names.json.tmp'));
  });

  afterEach(async () => {
    await waitForDrain();
    delete process.env.PA_HOME;
    if (savedClaudeCmd === undefined) delete process.env.CLAUDE_CMD;
    else process.env.CLAUDE_CMD = savedClaudeCmd;
    (globalThis as Record<string, unknown>).fetch = savedFetch;
    await rmRetry(tempDir);
  });

  it('setup failure after key registration deletes the key and the error propagates to the poll loop', async () => {
    const controller = new AbortController();
    const state = makeState(456, -1);
    const topicNames: TopicNameMap = new Map();
    let getUpdatesCount = 0;
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => { gateResolve = r; });

    const warnings: Array<{ mod: string; msg: string; ctx?: any }> = [];
    const origWarn = logger.warn;
    const blockedTmpDir = join(tempDir, 'telegram-topic-names.json.tmp');

    // Bound the wait on `gate` so a mutation that swallows the rethrow (the
    // poll loop's own "processUpdate rejected" warning never fires) fails
    // through this test's own assertion instead of hanging the second
    // getUpdates batch forever, which node:test would otherwise only ever
    // surface as its own idle-event-loop cancellation.
    let propagationTimedOut = false;
    const GATE_TIMEOUT_MS = 5000;
    let timeoutHandle: NodeJS.Timeout;
    const boundedGate = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(() => {
        propagationTimedOut = true;
        // The logger.warn spy that would normally lift this block never
        // fires when propagation is swallowed — unblock it ourselves so the
        // third getUpdates batch (and thus the poll loop) can still run to
        // completion instead of hanging on a second EISDIR.
        rmSync(blockedTmpDir, { recursive: true, force: true });
        resolve();
      }, GATE_TIMEOUT_MS);
      gate.then(() => {
        clearTimeout(timeoutHandle);
        resolve();
      });
    });

    logger.warn = (mod: string, msg: string, ctx?: any) => {
      warnings.push({ mod, msg, ctx });
      if (mod === 'poll' && msg.startsWith('processUpdate rejected')) {
        // The branch handler's catch has already run (delete + rethrow are
        // synchronous, with no await between them) by the time this
        // rejection reaches the poll loop's own .catch. Safe to unblock the
        // write path now, before letting forum_topic_created through.
        rmSync(blockedTmpDir, { recursive: true, force: true });
        gateResolve();
      }
      origWarn.call(logger, mod, msg, ctx);
    };

    const branchUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 456, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        text: '/branch catch-test some purpose',
        message_thread_id: undefined as number | undefined,
      },
    };
    const ftcUpdate = {
      update_id: 2,
      message: {
        message_id: 11,
        chat: { id: 456, type: 'supergroup' },
        date: Math.floor(Date.now() / 1000),
        message_thread_id: 888,
        forum_topic_created: { name: 'catch-test', icon_color: 0 },
      },
    };

    (globalThis as Record<string, unknown>).fetch = async (url: string, _opts?: { body?: string }) => {
      if ((url as string).includes('getUpdates')) {
        getUpdatesCount++;
        if (getUpdatesCount === 1) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [branchUpdate] }), json: async () => ({ ok: true, result: [branchUpdate] }) };
        }
        if (getUpdatesCount === 2) {
          // Wait until the branch handler's rejection has propagated (and the
          // tmp-dir block has been lifted) before delivering
          // forum_topic_created, mirroring the production race where the two
          // updates arrive on separate poll batches. Bounded so a mutation
          // that swallows the propagation can't hang this batch forever.
          await boundedGate;
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [ftcUpdate] }), json: async () => ({ ok: true, result: [ftcUpdate] }) };
        }
        controller.abort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: [] }), json: async () => ({ ok: true, result: [] }) };
      }
      if ((url as string).includes('createForumTopic')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_thread_id: 888 } }), json: async () => ({ ok: true, result: { message_thread_id: 888 } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 99 } }), json: async () => ({ ok: true, result: { message_id: 99 } }) };
    };

    try {
      await runPollLoop('token', [456], state, {}, controller.signal, fastSleep, undefined, topicNames, new Map());

      assert.ok(
        !propagationTimedOut,
        'processUpdate rejection must propagate to the poll loop'
      );

      const rejectedWarn = warnings.find(w => w.mod === 'poll' && w.msg.startsWith('processUpdate rejected'));
      assert.ok(
        rejectedWarn,
        `the /branch handler's rethrown setup error must propagate out of processUpdate to the poll loop, not be swallowed; warnings seen: ${JSON.stringify(warnings)}`
      );

      const entry = topicNames.get('456')?.get(888);
      assert.ok(entry, 'topic 888 must have a registered name entry from forum_topic_created');
      assert.ok(
        entry!.description?.includes('Discussions and tasks relating to'),
        `the provisional key must be deleted on setup failure so forum_topic_created's own fallback description still applies; got: ${JSON.stringify(entry?.description)}`
      );
    } finally {
      logger.warn = origWarn;
    }
  });
});
