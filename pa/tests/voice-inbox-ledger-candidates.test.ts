import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createTempPaHome, cleanup } from './helpers.js';
import {
  voiceInboxPlacementCandidates,
  voiceInboxLedgerPath,
} from '../src/lib/voice-inbox-ledger.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function ledgerDir(): string {
  return join(tempDir, 'voice-inbox');
}

/** Single source of fixture ids — guarantees the `vi-<12 hex>` shape. */
const vid = (n: number): string => `vi-${n.toString(16).padStart(12, '0')}`;

interface TaskRow {
  conversation_id: string;
  state: string;
  updated_at: string;
  routed_to?: string | null;
  request_text?: string;
}

interface MetaRow {
  conversation_id: string;
  title?: string | null;
}

/** Build a v15-shaped fixture ledger (tasks + conversation_meta) with the
 *  columns `voiceInboxPlacementCandidates` reads. task_id = conversation_id
 *  (one row per entry unless several share a conversation_id). Closes the
 *  handle before returning — a still-open handle on Windows turns the
 *  afterEach rm() into a silent no-op (EBUSY), letting a stale fixture leak
 *  into the next test. */
async function buildLedger(tasks: TaskRow[], meta: MetaRow[] = []): Promise<void> {
  await mkdir(ledgerDir(), { recursive: true });
  const db = new Database(voiceInboxLedgerPath());
  try {
    db.exec(`CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      routed_to TEXT,
      request_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE conversation_meta (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      updated_at TEXT NOT NULL
    )`);
    const ins = db.prepare(
      `INSERT INTO tasks (task_id, conversation_id, state, routed_to, request_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    tasks.forEach((r, i) => {
      const taskId = tasks.length === new Set(tasks.map((t) => t.conversation_id)).size
        ? r.conversation_id
        : `${r.conversation_id}-${i}`; // disambiguate multi-row conversations; not read by the reader
      ins.run(taskId, r.conversation_id, r.state, r.routed_to ?? null, r.request_text ?? `ask for ${r.conversation_id}`, r.updated_at, r.updated_at);
    });
    const insMeta = db.prepare('INSERT INTO conversation_meta (conversation_id, title, updated_at) VALUES (?, ?, ?)');
    for (const m of meta) insMeta.run(m.conversation_id, m.title ?? null, '2026-09-18T00:00:00Z');
  } finally {
    db.close();
  }
}

describe('voiceInboxPlacementCandidates — candidate shape', async () => {
  it('returns newest row per conversation, newest-updated first, title folded from conversation_meta', async () => {
    // Conv A has TWO rows: the NEWEST (08:20) must supply every surfaced field.
    await buildLedger(
      [
        { conversation_id: vid(0xa), state: 'done', updated_at: '2026-09-18T08:20:00Z', routed_to: '100_5' },
        { conversation_id: vid(0xa), state: 'running', updated_at: '2026-09-18T08:00:00Z', routed_to: '100_1' },
        { conversation_id: vid(0xb), state: 'running', updated_at: '2026-09-18T08:10:00Z', routed_to: '200_9' },
      ],
      [{ conversation_id: vid(0xa), title: 'Farm bio-fence plan' }],
    );
    const out = voiceInboxPlacementCandidates(25);
    assert.deepEqual(
      out.map((c) => [c.conversationId, c.goal, c.status, c.routedTo, c.updatedAt]),
      [
        [vid(0xa), 'Farm bio-fence plan', 'done', '100_5', '2026-09-18T08:20:00Z'],
        [vid(0xb), `ask for ${vid(0xb)}`, 'running', '200_9', '2026-09-18T08:10:00Z'],
      ],
    );
    // Newest row is done -> conversation NOT inflight (the older running row must not leak).
    assert.equal(out[0].inflight, false);
    assert.equal(out[1].inflight, true);
  });

  it('goal falls back to newest request_text when title is NULL, empty, or meta row absent', async () => {
    await buildLedger(
      [
        { conversation_id: vid(0xc), state: 'done', updated_at: '2026-09-18T09:00:00Z', request_text: 'plan the fence gate' },
        { conversation_id: vid(0xd), state: 'done', updated_at: '2026-09-18T09:01:00Z', request_text: 'review the sketch' },
        { conversation_id: vid(0xe), state: 'done', updated_at: '2026-09-18T09:02:00Z', request_text: 'order wire rolls' },
      ],
      [
        { conversation_id: vid(0xc), title: null },
        { conversation_id: vid(0xd), title: '' },
      ],
    );
    const out = voiceInboxPlacementCandidates(25);
    assert.deepEqual(
      out.map((c) => c.goal),
      ['order wire rolls', 'review the sketch', 'plan the fence gate'],
    );
  });

  it('inflight is true exactly for the five in-flight states', async () => {
    const states = [
      'received',
      'transcribing',
      'routed',
      'running',
      'awaiting_input',
      'done',
      'failed',
      'cancelled',
      'transcribe_failed',
    ];
    await buildLedger(
      states.map((state, i) => ({ conversation_id: vid(0x10 + i), state, updated_at: `2026-09-18T08:${String(10 + i).padStart(2, '0')}:00Z` })),
    );
    const out = voiceInboxPlacementCandidates(25);
    const inflightStates = new Set(['received', 'transcribing', 'routed', 'running', 'awaiting_input']);
    for (let i = 0; i < states.length; i++) {
      const c = out.find((x) => x.conversationId === vid(0x10 + i));
      assert.ok(c, `candidate ${vid(0x10 + i)} (${states[i]}) missing`);
      assert.equal(c.inflight, inflightStates.has(states[i]), `state ${states[i]} misclassified`);
    }
  });
});

describe('voiceInboxPlacementCandidates — cap and m3 exemption', async () => {
  it('cap truncates oldest-updated-first; kept stay newest-updated first', async () => {
    await buildLedger(
      Array.from({ length: 5 }, (_, i) => ({
        conversation_id: vid(0x20 + i),
        state: 'done',
        updated_at: `2026-09-18T08:0${i}:00Z`,
      })),
    );
    const out = voiceInboxPlacementCandidates(2);
    assert.deepEqual(out.map((c) => c.conversationId), [vid(0x24), vid(0x23)]);
  });

  it('m3: the current conversation is swapped in and the OLDEST KEPT is evicted', async () => {
    await buildLedger(
      [0, 1, 2].map((i) => ({
        conversation_id: vid(0x30 + i),
        state: 'running',
        updated_at: `2026-09-18T08:0${i}:00Z`,
      })),
    );
    // Cap 2 without the exemption drops the oldest (08:00 = vid(0x30)).
    // currentConversationId = vid(0x30) -> swapped IN; the oldest KEPT
    // (08:01 = vid(0x31)) is evicted instead.
    const out = voiceInboxPlacementCandidates(2, vid(0x30));
    assert.deepEqual(out.map((c) => c.conversationId), [vid(0x32), vid(0x30)]);
    assert.equal(out.some((c) => c.conversationId === vid(0x31)), false);
  });

  it('m3: exemption is a no-op when the current conversation survives truncation', async () => {
    await buildLedger(
      [0, 1, 2].map((i) => ({
        conversation_id: vid(0x40 + i),
        state: 'done',
        updated_at: `2026-09-18T09:0${i}:00Z`,
      })),
    );
    // The current conversation is the NEWEST — already kept, nothing evicted.
    const out = voiceInboxPlacementCandidates(2, vid(0x42));
    assert.deepEqual(out.map((c) => c.conversationId), [vid(0x42), vid(0x41)]);
  });

  it('m3: an unknown or malformed current conversation id is ignored', async () => {
    await buildLedger(
      [0, 1, 2].map((i) => ({
        conversation_id: vid(0x50 + i),
        state: 'done',
        updated_at: `2026-09-18T10:0${i}:00Z`,
      })),
    );
    const unknown = voiceInboxPlacementCandidates(2, vid(0xff));
    assert.deepEqual(unknown.map((c) => c.conversationId), [vid(0x52), vid(0x51)]);
    const malformed = voiceInboxPlacementCandidates(2, 'not-an-id');
    assert.deepEqual(malformed.map((c) => c.conversationId), [vid(0x52), vid(0x51)]);
  });

  it('rows with empty conversation_id never appear (I-1 structural exclusion)', async () => {
    await buildLedger([
      { conversation_id: '', state: 'running', updated_at: '2026-09-18T11:00:00Z' },
      { conversation_id: vid(0x60), state: 'done', updated_at: '2026-09-18T11:01:00Z' },
    ]);
    const out = voiceInboxPlacementCandidates(25);
    assert.deepEqual(out.map((c) => c.conversationId), [vid(0x60)]);
  });

  it('cap 0 or negative returns []', async () => {
    await buildLedger([{ conversation_id: vid(0x61), state: 'done', updated_at: '2026-09-18T11:02:00Z' }]);
    assert.deepEqual(voiceInboxPlacementCandidates(0), []);
    assert.deepEqual(voiceInboxPlacementCandidates(-3), []);
  });
});

describe('voiceInboxPlacementCandidates — fail-open (each proven against a discriminating bad fixture)', async () => {
  it('missing ledger file -> []', async () => {
    await mkdir(ledgerDir(), { recursive: true });
    assert.deepEqual(voiceInboxPlacementCandidates(25), []);
  });

  it('schema without the columns the query names (pre-updated_at tasks) -> [] not a crash', async () => {
    // The GOOD path is proven by every test above returning rows from the same
    // call; this is the known-bad twin (2026-09-09 rule) that must take the
    // failure path.
    await mkdir(ledgerDir(), { recursive: true });
    const db = new Database(voiceInboxLedgerPath());
    try {
      db.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, state TEXT NOT NULL)');
      db.prepare('INSERT INTO tasks (task_id, state) VALUES (?, ?)').run(vid(0x62), 'running');
    } finally {
      db.close();
    }
    assert.deepEqual(voiceInboxPlacementCandidates(25), []);
  });
});
