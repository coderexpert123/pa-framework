// Voice-inbox route bridge (AI-201): the bot-side drain of
// ~/.pa/voice-inbox/route-queue.jsonl and the /pair pairing-code mint.
// MUST stay first — sandboxes PA_HOME against real side effects (test-env-guard contract).
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import lockfile from 'proper-lockfile';
import {
  drainVoiceInboxRoutes,
  handlePairCommand,
  handleRouteCancel,
  extractVoiceInboxTaskIds,
  PAIR_PATTERN,
  type RouteQueueEntry,
} from '../voice-inbox-bridge.js';
import type { TelegramUpdate } from '../types.js';
import type { PendingDispatch } from '../pending-dispatches.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;
/** The unambiguous pairing charset (no 0/O/1/I/L) — must match the bridge's mint. */
const PAIRING_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

let testHome: string;
let queuePath: string;

/**
 * One route-queue line in the §-pinned byte shape (key order q_id, ts, task_id,
 * tenant_id, chat_id, thread_id, text, ref_id). CI does not build the
 * voice-inbox package, so this fixture re-states the pinned producer shape
 * rather than importing it — the producer's own suite asserts the byte shape
 * over there, and the integration e2e drives the live seam.
 */
function queueLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    q_id: 'rq-a1b2c3d4e5f6',
    ts: '2026-09-05T18:00:00.000Z',
    task_id: 'vi-1234567890ab',
    tenant_id: 't-424242',
    chat_id: CHAT_ID,
    thread_id: THREAD_ID,
    text: '[Voice task vi-1234567890ab routed from inbox — reason: fixture] Run the thing.',
    ref_id: 's-0987654321fe',
    ...over,
  });
}

async function writeQueue(content: string): Promise<void> {
  await mkdir(join(testHome, 'voice-inbox'), { recursive: true });
  await writeFile(queuePath, content, 'utf8');
}

async function readQueue(): Promise<string> {
  return readFile(queuePath, 'utf8');
}

/** Injection seam double: records every update, optionally throwing. */
function makeInjectFn(impl: (u: TelegramUpdate) => void = () => {}) {
  const seen: TelegramUpdate[] = [];
  const fn = (u: TelegramUpdate): void => { seen.push(u); impl(u); };
  return { seen, fn };
}

let idCounter = 1000;
const nextId = (): number => ++idCounter;

describe('voice-inbox-bridge', () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'pa-vi-bridge-'));
    queuePath = join(testHome, 'voice-inbox', 'route-queue.jsonl');
    idCounter = 1000;
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true }).catch(() => {});
  });

  describe('drainVoiceInboxRoutes', () => {
    it('is a no-op when the queue file does not exist', async () => {
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
      assert.equal(n, 0);
      assert.equal(seen.length, 0);
    });

    it('is a no-op on an existing empty queue file (no rewrite churn)', async () => {
      await writeQueue('');
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
      assert.equal(n, 0);
      assert.equal(seen.length, 0);
      assert.equal(await readQueue(), '');
    });

    it('injects each line as a route-tagged synthetic turn and empties the file', async () => {
      const textA = queueLine();
      const textB = queueLine({
        q_id: 'rq-ffffffffff01',
        chat_id: -1001234567890,
        thread_id: 5002,
        text: '[Voice inbox task vi-1234567890ab] Pick a topic.',
      });
      await writeQueue(`${textA}\n${textB}\n`);
      const { seen, fn } = makeInjectFn();

      const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
      assert.equal(n, 2);
      assert.equal(seen.length, 2);

      for (const u of seen) {
        assert.equal((u as any).__synthetic, 'route');
        assert.equal(u.message!.message_id, 0, 'no anchor — message_id stays 0');
        assert.equal(u.message!.from!.id, 0);
        assert.equal(u.message!.chat.id, CHAT_ID);
        assert.equal(u.message!.date > 0, true);
      }
      assert.equal(seen[0].message!.text, JSON.parse(textA).text);
      assert.equal(seen[0].message!.message_thread_id, THREAD_ID, 'target topic thread carries message_thread_id');
      assert.equal(seen[1].message!.message_thread_id, 5002);
      assert.notEqual(seen[0].update_id, seen[1].update_id, 'synthetic ids must be unique per entry');

      assert.equal(await readQueue(), '', 'consume-after-inject rewrites the file empty');
    });

    it('leaves the file intact when an injection throws (re-injection on restart)', async () => {
      await writeQueue(`${queueLine()}\n${queueLine({ q_id: 'rq-ffffffffff02' })}\n`);
      const { fn } = makeInjectFn((u) => {
        if ((u as any).__synthetic === 'route') throw new Error('injection pipeline down');
      });

      await assert.rejects(
        () => drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath }),
        /injection pipeline down/
      );
      const kept = await readQueue();
      assert.match(kept, /rq-a1b2c3d4e5f6/);
      assert.match(kept, /rq-ffffffffff02/, 'nothing may be consumed when injection fails');
    });

    it('drops an unparsable line with a warning instead of injecting it forever', async () => {
      await writeQueue(`${queueLine()}\nnot-json-at-all\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
      assert.equal(n, 1);
      assert.equal(seen.length, 1);
      assert.equal(await readQueue(), '', 'the malformed line is consumed, not re-read every tick');
    });

    it('drops a non-object line (bare null) instead of crashing the drain', async () => {
      await writeQueue(`${queueLine()}\nnull\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
      assert.equal(n, 1);
      assert.equal(seen.length, 1);
      assert.equal(await readQueue(), '');
    });

    it('skips the tick untouched when a writer holds the queue lock', async () => {
      await writeQueue(`${queueLine()}\n`);
      const release = await lockfile.lock(queuePath, { stale: 60_000 });
      try {
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
        assert.equal(n, 0, 'locked queue = no-op tick');
        assert.equal(seen.length, 0);
        assert.equal(await readQueue(), `${queueLine()}\n`, 'file must be untouched behind a live lock');
      } finally {
        await release();
      }
    });

    describe('cancel verb (kind:"cancel", §4 FROZEN route-queue contract v2, AI-214 backend redesign)', () => {
      it('a cancel entry is consumed, never counted as injected, and the queue is emptied', async () => {
        const cancelLine = queueLine({
          q_id: 'rq-cancel0001',
          task_id: 'vi-abcdefabcdef',
          text: '[Voice inbox task vi-abcdefabcdef cancelled by the operator]',
          kind: 'cancel',
          worker_resource: '',
        });
        await writeQueue(`${cancelLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
        assert.equal(n, 0, 'a cancel entry is acted on, not injected — it never increments the count');
        assert.equal(seen.length, 0, 'never reaches injectFn');
        assert.equal(await readQueue(), '', 'still consumed off the queue');
      });

      it('a mixed file (one cancel + one route line) leaves the queue empty and injects exactly once', async () => {
        const cancelLine = queueLine({
          q_id: 'rq-cancel0002',
          task_id: 'vi-abcdefabcdef',
          text: '[Voice inbox task vi-abcdefabcdef cancelled by the operator]',
          kind: 'cancel',
          worker_resource: '',
        });
        const routeLine = queueLine({ q_id: 'rq-route0001' });
        await writeQueue(`${cancelLine}\n${routeLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
        assert.equal(n, 1, 'only the route line counts as injected');
        assert.equal(seen.length, 1);
        assert.equal(await readQueue(), '');
      });

      it('a normal (no-kind) line still injects exactly as today', async () => {
        await writeQueue(`${queueLine()}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath });
        assert.equal(n, 1);
        assert.equal(seen.length, 1);
        assert.equal((seen[0] as any).__synthetic, 'route');
      });
    });

    describe('steer verb (kind:"steer", WP-5 E-C4 drain restructure)', () => {
      it('a settled steer is consumed and never injected', async () => {
        const steerLine = queueLine({ q_id: 'rq-steer0001', kind: 'steer', steer_mode: 'interrupt', steer_conversation: 'vi-aaaaaaaaaaaa' });
        await writeQueue(`${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => ({ settled: true }),
        });
        assert.equal(n, 0, 'settling a steer never counts as an injected turn');
        assert.equal(seen.length, 0);
        assert.equal(await readQueue(), '');
      });

      it('an unsettled steer with nothing to fold into, not past its deadline, is held for the next tick and retried', async () => {
        const steerLine = queueLine({ q_id: 'rq-steer0002', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa' });
        await writeQueue(`${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        let calls = 0;
        const opts = {
          injectFn: fn, nextId, queuePath,
          steerFn: async () => { calls++; return { settled: false }; },
          isPastDeadline: () => false,
        };
        const n = await drainVoiceInboxRoutes(opts);
        assert.equal(n, 0);
        assert.equal(seen.length, 0);
        assert.match(await readQueue(), /rq-steer0002/, 'held: not consumed');
        const n2 = await drainVoiceInboxRoutes(opts);
        assert.equal(n2, 0);
        assert.equal(calls, 2, 'the held entry is retried on the next tick');
      });

      it('an unsettled steer past its deadline is injected as an ordinary turn and consumed', async () => {
        const steerLine = queueLine({ q_id: 'rq-steer0003', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa' });
        await writeQueue(`${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => ({ settled: false }),
          isPastDeadline: () => true,
        });
        assert.equal(n, 1);
        assert.equal(seen.length, 1);
        assert.equal(await readQueue(), '');
      });

      it('folds into a sibling route line not yet started: the steer is consumed, the sibling injects once with the merged text', async () => {
        const siblingLine = queueLine({ q_id: 'rq-sibling0001', task_id: 'vi-origtaskorig', text: 'SIBLING TEXT' });
        const steerLine = queueLine({ q_id: 'rq-steer0004', task_id: 'vi-origtaskorig', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa', text: 'ADD THIS TOO' });
        await writeQueue(`${siblingLine}\n${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => ({ settled: false }),
          conversationTaskIdsFn: () => ['vi-origtaskorig'],
          foldPrefix: '[FOLD] ',
        });
        assert.equal(n, 1, 'only the sibling counts as an injected turn');
        assert.equal(seen.length, 1);
        assert.equal(seen[0].message!.text, 'SIBLING TEXT\n\n[FOLD] ADD THIS TOO');
        assert.equal(await readQueue(), '');
      });

      it('when two siblings match, the fold picks the NEWEST (highest index) one', async () => {
        const older = queueLine({ q_id: 'rq-sibling-older', task_id: 'vi-origtaskorig', text: 'OLDER SIBLING' });
        const newer = queueLine({ q_id: 'rq-sibling-newer', task_id: 'vi-origtaskorig', text: 'NEWER SIBLING' });
        const steerLine = queueLine({ q_id: 'rq-steer0005', task_id: 'vi-origtaskorig', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa', text: 'STEER TEXT' });
        await writeQueue(`${older}\n${newer}\n${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => ({ settled: false }),
          conversationTaskIdsFn: () => ['vi-origtaskorig'],
          foldPrefix: '',
        });
        assert.equal(n, 2, 'both siblings still inject: the untouched one plus the folded one');
        const texts = seen.map((u) => u.message!.text);
        assert.ok(texts.includes('OLDER SIBLING'), 'the non-target sibling is untouched');
        assert.ok(texts.includes('NEWER SIBLING\n\nSTEER TEXT'), 'the newest (highest-index) sibling absorbs the fold');
      });

      it('the fold never targets a kind:"cancel" line nor the steer entry itself', async () => {
        const cancelLine = queueLine({ q_id: 'rq-cancel-fold', task_id: 'vi-origtaskorig', kind: 'cancel', worker_resource: '', text: '[Voice inbox task vi-origtaskorig cancelled by the operator]' });
        const steerLine = queueLine({ q_id: 'rq-steer0006', task_id: 'vi-origtaskorig', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa', text: 'STEER TEXT' });
        await writeQueue(`${cancelLine}\n${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => ({ settled: false }),
          conversationTaskIdsFn: () => ['vi-origtaskorig'],
          isPastDeadline: () => false,
        });
        assert.equal(n, 0, 'the cancel is acted on separately (never injected) and the steer has nothing to fold into, so it holds');
        assert.equal(seen.length, 0);
        const remaining = await readQueue();
        assert.match(remaining, /rq-steer0006/, 'the steer is held, not consumed');
        assert.doesNotMatch(remaining, /rq-cancel-fold/, 'the cancel line is still acted on and consumed independently');
      });

      it('with no steerFn, a steer line is held (never injected) until it is past its deadline', async () => {
        const steerLine = queueLine({ q_id: 'rq-steer0007', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa' });
        await writeQueue(`${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({ injectFn: fn, nextId, queuePath, isPastDeadline: () => false });
        assert.equal(n, 0);
        assert.equal(seen.length, 0);
        assert.match(await readQueue(), /rq-steer0007/, 'held, not consumed');
      });

      it('a steerFn that throws is treated as unsettled and the entry is held', async () => {
        const steerLine = queueLine({ q_id: 'rq-steer0008', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa' });
        await writeQueue(`${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => { throw new Error('boom'); },
          isPastDeadline: () => false,
        });
        assert.equal(n, 0);
        assert.equal(seen.length, 0);
        assert.match(await readQueue(), /rq-steer0008/, 'held after the throw');
      });

      it('a mixed file (cancel + steer + sibling) empties the queue: cancel acted on once, sibling injected once with the fold merged in', async () => {
        const cancelLine = queueLine({ q_id: 'rq-cancel-mixed', task_id: 'vi-cancelme000', kind: 'cancel', worker_resource: '', text: '[Voice inbox task vi-cancelme000 cancelled by the operator]' });
        const siblingLine = queueLine({ q_id: 'rq-sibling-mixed', task_id: 'vi-origtaskorig', text: 'SIBLING TEXT' });
        const steerLine = queueLine({ q_id: 'rq-steer-mixed', task_id: 'vi-origtaskorig', kind: 'steer', steer_conversation: 'vi-aaaaaaaaaaaa', text: 'STEER TEXT' });
        await writeQueue(`${cancelLine}\n${siblingLine}\n${steerLine}\n`);
        const { seen, fn } = makeInjectFn();
        const n = await drainVoiceInboxRoutes({
          injectFn: fn, nextId, queuePath,
          steerFn: async () => ({ settled: false }),
          conversationTaskIdsFn: () => ['vi-origtaskorig'],
          foldPrefix: '[FOLD] ',
        });
        assert.equal(n, 1, 'only the sibling counts as an injected turn');
        assert.equal(seen.length, 1);
        assert.equal(seen[0].message!.text, 'SIBLING TEXT\n\n[FOLD] STEER TEXT');
        assert.equal(await readQueue(), '', 'the queue is fully emptied');
      });
    });

    it('holds a plain entry whose task is still transcribing — not injected, not consumed', async () => {
      await writeQueue(`${queueLine()}\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'transcribing' }]]),
      });
      assert.equal(n, 0);
      assert.equal(seen.length, 0);
      assert.match(await readQueue(), /rq-a1b2c3d4e5f6/);
    });

    it('injects a held entry on the first drain after its task leaves transcribing', async () => {
      await writeQueue(`${queueLine()}\n`);
      const held = makeInjectFn();
      const n0 = await drainVoiceInboxRoutes({
        injectFn: held.fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'transcribing' }]]),
      });
      assert.equal(n0, 0);
      assert.equal(held.seen.length, 0);

      const { seen, fn } = makeInjectFn();
      const n1 = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'received' }]]),
      });
      assert.equal(n1, 1);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].message!.text, JSON.parse(queueLine()).text);
      assert.doesNotMatch(await readQueue(), /rq-a1b2c3d4e5f6/);
    });

    it('consumes a plain entry whose task is transcribe_failed without injecting it', async () => {
      await writeQueue(`${queueLine()}\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'transcribe_failed' }]]),
      });
      assert.equal(n, 0);
      assert.equal(seen.length, 0);
      assert.doesNotMatch(await readQueue(), /rq-a1b2c3d4e5f6/);
    });

    it('injects as before when taskStatesFn is absent or does not know the task', async () => {
      await writeQueue(`${queueLine()}\n`);
      const a = makeInjectFn();
      const nA = await drainVoiceInboxRoutes({ injectFn: a.fn, nextId, queuePath });
      assert.equal(nA, 1);

      await writeQueue(`${queueLine()}\n`);
      const b = makeInjectFn();
      const nB = await drainVoiceInboxRoutes({
        injectFn: b.fn, nextId, queuePath,
        taskStatesFn: () => new Map(),
      });
      assert.equal(nB, 1);
    });

    it('a throwing taskStatesFn fails open and the entry injects', async () => {
      await writeQueue(`${queueLine()}\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => { throw new Error('ledger busy'); },
      });
      assert.equal(n, 1);
      assert.equal(seen.length, 1);
    });

    const INBOX_TEXT = '[Voice inbox task vi-1234567890ab] Request: buy milk. Pick the best topic for it.';

    it('typed routing gate hold keeps a received inbox entry: not injected, not consumed', async () => {
      await writeQueue(`${queueLine({ text: INBOX_TEXT })}\n`);
      const { seen, fn } = makeInjectFn();
      const calls: Array<[string, string]> = [];
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'received' }]]),
        typedRouteFn: (taskId, state) => { calls.push([taskId, state]); return 'hold'; },
      });
      assert.equal(n, 0);
      assert.equal(seen.length, 0);
      assert.match(await readQueue(), /rq-a1b2c3d4e5f6/);
      assert.deepEqual(calls, [['vi-1234567890ab', 'received']]);
    });

    it('typed routing gate drop consumes a routed inbox entry without injecting', async () => {
      await writeQueue(`${queueLine({ text: INBOX_TEXT })}\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'routed' }]]),
        typedRouteFn: () => 'drop',
      });
      assert.equal(n, 0);
      assert.equal(seen.length, 0);
      assert.doesNotMatch(await readQueue(), /rq-a1b2c3d4e5f6/);
    });

    it('typed routing gate inject passes the inbox entry through unchanged', async () => {
      await writeQueue(`${queueLine({ text: INBOX_TEXT })}\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'received' }]]),
        typedRouteFn: () => 'inject',
      });
      assert.equal(n, 1);
      assert.equal(seen[0].message!.text, INBOX_TEXT);
    });

    it('the typed routing gate never sees a destination entry even when its task is routed', async () => {
      await writeQueue(`${queueLine()}\n`);
      const { seen, fn } = makeInjectFn();
      let count = 0;
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'routed' }]]),
        typedRouteFn: () => { count += 1; return 'hold'; },
      });
      assert.equal(count, 0);
      assert.equal(n, 1);
      assert.equal(seen.length, 1);
    });

    it('a throwing typed routing gate injects', async () => {
      await writeQueue(`${queueLine({ text: INBOX_TEXT })}\n`);
      const { seen, fn } = makeInjectFn();
      const n = await drainVoiceInboxRoutes({
        injectFn: fn, nextId, queuePath,
        taskStatesFn: () => new Map([['vi-1234567890ab', { state: 'received' }]]),
        typedRouteFn: () => { throw new Error('gate down'); },
      });
      assert.equal(n, 1);
      assert.equal(seen.length, 1);
    });
  });

  describe('extractVoiceInboxTaskIds', () => {
    it('matches the inbox/voice-inbox injection opening', () => {
      assert.deepEqual(
        extractVoiceInboxTaskIds('[Voice inbox task vi-1234567890ab] Errands: water the plants.'),
        ['vi-1234567890ab'],
      );
    });

    it('matches the target injection opening ("routed")', () => {
      assert.deepEqual(
        extractVoiceInboxTaskIds('[Voice task vi-1111aaaa2222 routed from inbox — reason: matched Errands] Do the thing.'),
        ['vi-1111aaaa2222'],
      );
    });

    it('matches the cancel-notice opening ("cancelled by the operator")', () => {
      assert.deepEqual(
        extractVoiceInboxTaskIds('[Voice inbox task vi-abcdefabcdef cancelled by the operator]'),
        ['vi-abcdefabcdef'],
      );
    });

    it('extracts both ids from a two-task batched string, de-duplicated and in order', () => {
      assert.deepEqual(
        extractVoiceInboxTaskIds(
          'Batch: [Voice inbox task vi-1111aaaa2222] then [Voice task vi-3333bbbb4444 routed] go, ' +
          'again [Voice inbox task vi-1111aaaa2222] repeated',
        ),
        ['vi-1111aaaa2222', 'vi-3333bbbb4444'],
      );
    });

    it('returns [] when no task id is present', () => {
      assert.deepEqual(extractVoiceInboxTaskIds('no task ids in this text'), []);
    });
  });

  describe('handleRouteCancel', () => {
    function makeEntry(over: Partial<RouteQueueEntry> = {}): RouteQueueEntry {
      return {
        q_id: 'rq-cancel-unit',
        ts: '2026-09-08T18:00:00.000Z',
        task_id: 'vi-1234567890ab',
        tenant_id: 't-424242',
        chat_id: CHAT_ID,
        thread_id: THREAD_ID,
        text: '[Voice inbox task vi-1234567890ab cancelled by the operator]',
        ref_id: 's-cancel-unit',
        kind: 'cancel',
        ...over,
      };
    }

    function makePending(over: Partial<PendingDispatch>): PendingDispatch {
      return {
        updateId: 1,
        chatId: CHAT_ID,
        threadId: THREAD_ID,
        messageId: 1,
        userText: 'placeholder',
        startedAt: '2026-09-08T18:00:00.000Z',
        ...over,
      };
    }

    it('a thread-shaped worker_resource: kills that resource, cancels the derived thread, purges the matching pending record', async () => {
      const stopCalls: string[] = [];
      const cancelCalls: Array<{ key: string; id: string }> = [];
      const removed: string[] = [];
      const pending = [
        makePending({ updateId: 1, userText: '[Voice inbox task vi-1234567890ab] do it' }),
        makePending({ updateId: 2, userText: 'unrelated text' }),
      ];
      await handleRouteCancel(makeEntry({ worker_resource: `topic-${CHAT_ID}_${THREAD_ID}-th4` }), {
        stop: async (r) => { stopCalls.push(r); return 2; },
        cancelThread: async (key, id) => { cancelCalls.push({ key, id }); return true; },
        listPending: async () => pending,
        removePending: async (key) => { removed.push(key); },
      });
      assert.deepEqual(stopCalls, [`topic-${CHAT_ID}_${THREAD_ID}-th4`]);
      assert.deepEqual(cancelCalls, [{ key: `${CHAT_ID}_${THREAD_ID}`, id: 't-4' }]);
      assert.deepEqual(removed, [`${CHAT_ID}:${THREAD_ID}:1`]);
    });

    it('an empty worker_resource: purges but never calls stop or cancelThread', async () => {
      let stopCalled = false;
      let cancelCalled = false;
      const removed: string[] = [];
      await handleRouteCancel(makeEntry({ worker_resource: undefined }), {
        stop: async () => { stopCalled = true; return 0; },
        cancelThread: async () => { cancelCalled = true; return false; },
        listPending: async () => [makePending({ updateId: 5, userText: '[Voice inbox task vi-1234567890ab] hi' })],
        removePending: async (key) => { removed.push(key); },
      });
      assert.equal(stopCalled, false);
      assert.equal(cancelCalled, false);
      assert.deepEqual(removed, [`${CHAT_ID}:${THREAD_ID}:5`]);
    });

    it('a non-thread worker_resource calls stop but not cancelThread', async () => {
      let cancelCalled = false;
      await handleRouteCancel(makeEntry({ worker_resource: `topic-${CHAT_ID}_${THREAD_ID}` }), {
        stop: async () => 1,
        cancelThread: async () => { cancelCalled = true; return true; },
        listPending: async () => [],
        removePending: async () => {},
      });
      assert.equal(cancelCalled, false);
    });

    it('purges BOTH pending records naming the same task (the live incident had two)', async () => {
      const removed: string[] = [];
      await handleRouteCancel(makeEntry({ worker_resource: '' }), {
        listPending: async () => [
          makePending({ updateId: 10, userText: '[Voice inbox task vi-1234567890ab] a' }),
          makePending({ updateId: 11, userText: '[Voice inbox task vi-1234567890ab] b' }),
          makePending({ updateId: 12, userText: 'unrelated' }),
        ],
        removePending: async (key) => { removed.push(key); },
      });
      assert.deepEqual(removed.sort(), [`${CHAT_ID}:${THREAD_ID}:10`, `${CHAT_ID}:${THREAD_ID}:11`].sort());
    });

    it('a failing stop() does not prevent the purge from running (each step is individually try/caught)', async () => {
      const removed: string[] = [];
      await handleRouteCancel(makeEntry({ worker_resource: `topic-${CHAT_ID}_${THREAD_ID}-th9` }), {
        stop: async () => { throw new Error('boom'); },
        cancelThread: async () => true,
        listPending: async () => [makePending({ updateId: 20, userText: '[Voice inbox task vi-1234567890ab] a' })],
        removePending: async (key) => { removed.push(key); },
      });
      assert.deepEqual(removed, [`${CHAT_ID}:${THREAD_ID}:20`]);
    });

    describe('dispatch-identity guard (WP-5 D12/K14)', () => {
      it("passes the entry's worker_dispatch_id through to stop as the third argument", async () => {
        const stopArgs: unknown[][] = [];
        await handleRouteCancel(makeEntry({ worker_resource: `topic-${CHAT_ID}_${THREAD_ID}-th4`, worker_dispatch_id: 'a1b2c3d4e5f6' }), {
          stop: async (r, d, id) => { stopArgs.push([r, d, id]); return 1; },
          cancelThread: async () => true,
          listPending: async () => [],
          removePending: async () => {},
        });
        assert.deepEqual(stopArgs, [[`topic-${CHAT_ID}_${THREAD_ID}-th4`, undefined, 'a1b2c3d4e5f6']]);
      });

      it('a bare topic resource with no dispatch id refuses to kill but still purges pending records (K14)', async () => {
        let stopCalled = false;
        const removed: string[] = [];
        await handleRouteCancel(makeEntry({ worker_resource: `topic-${CHAT_ID}_${THREAD_ID}`, worker_dispatch_id: undefined }), {
          stop: async () => { stopCalled = true; return 1; },
          cancelThread: async () => true,
          listPending: async () => [makePending({ updateId: 30, userText: '[Voice inbox task vi-1234567890ab] a' })],
          removePending: async (key) => { removed.push(key); },
        });
        assert.equal(stopCalled, false, 'never kills a bare topic resource with no dispatch id to prove it against');
        assert.deepEqual(removed, [`${CHAT_ID}:${THREAD_ID}:30`], 'the purge still runs unconditionally');
      });

      it('a thread resource with no dispatch id still kills by resource alone (already unambiguous, backward compatible)', async () => {
        const stopCalls: string[] = [];
        await handleRouteCancel(makeEntry({ worker_resource: `topic-${CHAT_ID}_${THREAD_ID}-th7`, worker_dispatch_id: undefined }), {
          stop: async (r) => { stopCalls.push(r); return 1; },
          cancelThread: async () => true,
          listPending: async () => [],
          removePending: async () => {},
        });
        assert.deepEqual(stopCalls, [`topic-${CHAT_ID}_${THREAD_ID}-th7`]);
      });
    });
  });

  describe('handlePairCommand', () => {
    const allowed = new Set([CHAT_ID]);
    const base = { chatId: CHAT_ID, userId: 424242, firstName: 'Op', allowedChatIds: allowed };
    let pairingPath: string;

    beforeEach(() => {
      pairingPath = join(testHome, 'voice-inbox', 'pairing-codes.json');
    });

    it('mints the canonical entry, appends, and returns the code in the reply', async () => {
      await mkdir(join(testHome, 'voice-inbox'), { recursive: true });
      const preExisting = [{ code: 'PREEXIST', telegram_user_id: 1, telegram_chat_id: CHAT_ID, first_name: null, created_at: '2026-09-05T00:00:00.000Z', expires_at: '2026-09-05T00:10:00.000Z' }];
      await writeFile(pairingPath, `${JSON.stringify(preExisting, null, 2)}\n`, 'utf8');

      const nowMs = 1_760_000_000_000;
      const reply = handlePairCommand({ ...base, now: () => nowMs, pairingPath, configPath: join(testHome, 'absent-config.yaml') });
      assert.match(reply, /Pairing code: ([A-Z2-9]{8})/);
      const code = /Pairing code: ([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})/.exec(reply)![1];
      assert.match(code, PAIRING_CODE_RE);

      const parsed = JSON.parse(await readFile(pairingPath, 'utf8'));
      assert.ok(Array.isArray(parsed), 'pairing-codes.json must stay a bare JSON array');
      assert.equal(parsed.length, 2, 'the mint must append, not clobber');
      const entry = parsed[1];
      assert.deepEqual(
        Object.keys(entry),
        ['code', 'telegram_user_id', 'telegram_chat_id', 'first_name', 'created_at', 'expires_at'],
        'exact canonical field set and order (identity.ts pin)'
      );
      assert.equal(entry.code, code, 'raw code at rest in the file');
      assert.equal(entry.telegram_user_id, 424242);
      assert.equal(entry.telegram_chat_id, CHAT_ID);
      assert.equal(entry.first_name, 'Op');
      assert.equal(entry.created_at, new Date(nowMs - 1000).toISOString());
      assert.equal(entry.expires_at, new Date(nowMs + 10 * 60_000).toISOString(), 'default TTL 10 minutes');
    });

    it('honors voice_inbox.pairing_ttl_minutes from config', async () => {
      const cfg = join(testHome, 'config.yaml');
      await writeFile(cfg, 'voice_inbox:\n  pairing_ttl_minutes: 3\n', 'utf8');
      const nowMs = 1_760_000_000_000;
      handlePairCommand({ ...base, now: () => nowMs, pairingPath, configPath: cfg });
      const entry = JSON.parse(await readFile(pairingPath, 'utf8'))[0];
      assert.equal(entry.expires_at, new Date(nowMs + 3 * 60_000).toISOString());
    });

    it('refuses a non-allowed chat and writes nothing', async () => {
      const reply = handlePairCommand({ ...base, chatId: -1009999999999, pairingPath });
      assert.doesNotMatch(reply, /Pairing code:/);
      await assert.rejects(() => readFile(pairingPath, 'utf8'), /ENOENT/, 'no pairing file may be written');
    });
  });

  describe('PAIR_PATTERN', () => {
    it('matches bare /pair only', () => {
      assert.equal(PAIR_PATTERN.test('/pair'), true);
      assert.equal(PAIR_PATTERN.test('/pair  '), true);
      assert.equal(PAIR_PATTERN.test('/pair extra'), false);
      assert.equal(PAIR_PATTERN.test('/pairing'), false);
      assert.equal(PAIR_PATTERN.test('/code'), false);
    });
  });

  describe('isKnownCommand seam', () => {
    it('/pair is known so the unknown-command guard cannot eat it', async () => {
      const { isKnownCommand } = await import('../logic.js');
      assert.equal(isKnownCommand('/pair'), true);
    });
  });
});
