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
import { drainVoiceInboxRoutes, handlePairCommand, PAIR_PATTERN } from '../voice-inbox-bridge.js';
import type { TelegramUpdate } from '../types.js';

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
