/**
 * Conversation briefing tests (AI-conversation-context WP-1, 2026-09-10;
 * rewritten t-3, 2026-09-18 for the lookup-reference format): the §3.2
 * rendered format (head + a single runnable sqlite3 lookup line + foot, no
 * more per-turn dump), the "nothing to say" empty case, the all-or-nothing
 * `maxChars` guard, bracketed-task-id neutralisation on the `conversation_meta`
 * fields, and the two cross-package pins (§3.1's `STEER_MESSAGE_LIMIT`
 * hand-copy of the bot's `STEER_MESSAGE_MAX`, and §3.4's budget arithmetic).
 *
 * Fixture A's expected string is the GOLDEN string
 * `tests/test_worker_scripts.py`'s `GOLDEN_BRIEFING` copies byte-for-byte —
 * the cross-language pin (§7.2 G4). Do not reword it here without moving the
 * python copy in the same change.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLedger, setConversationMeta, upsertTenant } from '../ledger.js';
import {
  CONVERSATION_BRIEFING_MAX,
  STEER_MESSAGE_LIMIT,
  briefingBudget,
  buildConversationBriefing,
  buildTargetInjectionTextWithBriefing,
  ledgerPathOf,
} from '../conversation-briefing.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url)); // dist/tests
const PKG_ROOT = join(TEST_DIR, '..', '..'); // projects/voice-inbox

const TENANT = 't-42';
const CONVO = 'vi-aaaaaaaaaaaa';
const LEDGER_PATH = 'C:/tmp/pa/voice-inbox/ledger.sqlite';

interface Fixture {
  db: ReturnType<typeof openLedger>;
  dir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-briefing-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  upsertTenant(db, { telegramUserId: 42, telegramChatId: -100042 });
  return {
    db,
    dir,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Direct row insert — `createTask` mints its own id/timestamps, but these
 * fixtures need explicit `task_id`/`created_at` to pin an exact turn order. */
function seedTask(
  db: Fixture['db'],
  row: {
    taskId: string;
    conversationId: string;
    requestText: string;
    resultSummary: string | null;
    state: string;
    createdAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO tasks
       (task_id, tenant_id, source, transcript, request_text, state, routed_to, routing_reason,
        result_summary, created_at, updated_at, conversation_id, worker_resource, worker_dispatch_id, steer_mode)
     VALUES (?, ?, 'text', NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(
    row.taskId,
    TENANT,
    row.requestText,
    row.state,
    row.resultSummary,
    row.createdAt,
    row.createdAt,
    row.conversationId
  );
}

/** Fixture A (golden) — §6.1 of the spec. */
function seedFixtureA(db: Fixture['db']): void {
  seedTask(db, {
    taskId: 'vi-aaaaaaaaaaaa',
    conversationId: CONVO,
    requestText: "Write a Strava caption for today's workout",
    resultSummary: 'Here are three caption options for the tempo run.',
    state: 'done',
    createdAt: '2026-09-09T10:00:00.000Z',
  });
  seedTask(db, {
    taskId: 'vi-bbbbbbbbbbbb',
    conversationId: CONVO,
    requestText: 'Make it shorter',
    resultSummary: null,
    state: 'running',
    createdAt: '2026-09-09T11:00:00.000Z',
  });
  seedTask(db, {
    taskId: 'vi-cccccccccccc',
    conversationId: CONVO,
    requestText: 'Not Rava. Strava.',
    resultSummary: null,
    state: 'routed',
    createdAt: '2026-09-10T09:00:00.000Z',
  });
  setConversationMeta(
    db,
    TENANT,
    CONVO,
    {
      title: "Strava caption for today's workout",
      recap: 'Three caption drafts are on the table; the operator wants a shorter one.',
      next_action: 'Pick one of the three captions.',
    },
    new Date().toISOString()
  );
}

/** Fixture C/D — eight prior turns, one hour apart, no conversation_meta,
 * plus the excluded current task. */
function seedFixtureC(db: Fixture['db']): void {
  const turnIds = [
    'vi-aaaaaaaaaaaa',
    'vi-d00000000002',
    'vi-d00000000003',
    'vi-d00000000004',
    'vi-d00000000005',
    'vi-d00000000006',
    'vi-d00000000007',
    'vi-d00000000008',
  ];
  turnIds.forEach((taskId, i) => {
    seedTask(db, {
      taskId,
      conversationId: CONVO,
      requestText: `turn ${i + 1}`,
      resultSummary: null,
      state: 'done',
      createdAt: `2026-09-01T${String(i).padStart(2, '0')}:00:00.000Z`,
    });
  });
  seedTask(db, {
    taskId: 'vi-cccccccccccc',
    conversationId: CONVO,
    requestText: 'the current follow-up',
    resultSummary: null,
    state: 'routed',
    createdAt: '2026-09-01T08:00:00.000Z',
  });
}

const GOLDEN_A =
  'Conversation so far (vi-aaaaaaaaaaaa): 2 earlier turn(s), oldest first.\n' +
  "Title: Strava caption for today's workout\n" +
  'Where it stands: Three caption drafts are on the table; the operator wants a shorter one.\n' +
  'Next: Pick one of the three captions.\n' +
  'Full turn-by-turn record: sqlite3 "C:/tmp/pa/voice-inbox/ledger.sqlite" "SELECT created_at, ' +
  "request_text, result_summary FROM tasks WHERE conversation_id = 'vi-aaaaaaaaaaaa' ORDER BY " +
  'created_at ASC".\n' +
  'End of the conversation record.\n';

describe('conversation briefing — format, budget and cross-package limits', () => {
  it('fixture A (golden): renders the exact §3.2 format for two prior turns plus meta', () => {
    const fx = makeFixture();
    try {
      seedFixtureA(fx.db);
      const result = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: 1200,
      });
      assert.equal(result, GOLDEN_A);
    } finally {
      fx.cleanup();
    }
  });

  it('fixture B (lookup line shape): the lookup line names the ledger path and conversation id exactly', () => {
    const fx = makeFixture();
    try {
      seedFixtureC(fx.db);
      const result = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: 1200,
      });
      assert.ok(
        result.includes(
          'Full turn-by-turn record: sqlite3 "C:/tmp/pa/voice-inbox/ledger.sqlite" "SELECT ' +
            "created_at, request_text, result_summary FROM tasks WHERE conversation_id = " +
            "'vi-aaaaaaaaaaaa' ORDER BY created_at ASC\".\n"
        ),
        result
      );
      // No per-turn content and no drop-count line survive from the old format.
      assert.equal(result.includes('You asked:'), false, result);
      assert.equal(result.includes('older turn(s)'), false, result);
    } finally {
      fx.cleanup();
    }
  });

  it('fixture C (all-or-nothing guard): maxChars too small to fit head+lookup+foot returns \'\', one char more fits', () => {
    const fx = makeFixture();
    try {
      seedFixtureC(fx.db);
      const full = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: 1200,
      });
      const threshold = full.length;
      const atThreshold = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: threshold,
      });
      assert.equal(atThreshold, full);
      const belowThreshold = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: threshold - 1,
      });
      assert.equal(belowThreshold, '');
    } finally {
      fx.cleanup();
    }
  });

  it('fixture D (never overflows, well under a large cap): the result never exceeds maxChars, and stays well under a generous cap', () => {
    const fx = makeFixture();
    try {
      seedFixtureC(fx.db);
      for (const maxChars of [0, 50, 100, 199, 200, 320, 600, 1200]) {
        const result = buildConversationBriefing(fx.db, TENANT, {
          conversationId: CONVO,
          excludeTaskId: 'vi-cccccccccccc',
          ledgerPath: LEDGER_PATH,
          maxChars,
        });
        assert.ok(
          result.length <= maxChars,
          `maxChars=${maxChars} produced length ${result.length}: ${result}`
        );
      }
      const generous = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: CONVERSATION_BRIEFING_MAX,
      });
      // The lookup-line format is roughly constant size regardless of how many
      // prior turns exist (8 here) — well under the hard cap, unlike the old
      // turn-dump format which grew with turn count.
      assert.ok(
        generous.length < CONVERSATION_BRIEFING_MAX / 2,
        `expected the fixed-size lookup format well under half the cap, got ${generous.length}: ${generous}`
      );
    } finally {
      fx.cleanup();
    }
  });

  it('fixture E (nothing to say): a conversation whose only task is the excluded one renders \'\'', () => {
    const fx = makeFixture();
    try {
      seedTask(fx.db, {
        taskId: 'vi-eeeeeeeeeeee',
        conversationId: 'vi-eeeeeeeeeeee',
        requestText: 'the only task',
        resultSummary: null,
        state: 'routed',
        createdAt: '2026-09-05T00:00:00.000Z',
      });
      const result = buildConversationBriefing(fx.db, TENANT, {
        conversationId: 'vi-eeeeeeeeeeee',
        excludeTaskId: 'vi-eeeeeeeeeeee',
        ledgerPath: LEDGER_PATH,
        maxChars: 1200,
      });
      assert.equal(result, '');
    } finally {
      fx.cleanup();
    }
  });

  it('fixture F (no bracketed task ids): a conversation_meta field carrying the bracket shape is neutralised', () => {
    const fx = makeFixture();
    try {
      seedFixtureA(fx.db);
      setConversationMeta(
        fx.db,
        TENANT,
        CONVO,
        { next_action: 'Routed [Voice task vi-0123456789ab] onward' },
        new Date().toISOString()
      );
      const result = buildConversationBriefing(fx.db, TENANT, {
        conversationId: CONVO,
        excludeTaskId: 'vi-cccccccccccc',
        ledgerPath: LEDGER_PATH,
        maxChars: 1200,
      });
      assert.equal(/\[Voice(?: inbox)? task vi-[0-9a-f]{12}(?=[\]\s])/.test(result), false, result);
      assert.ok(result.includes('(voice task vi-0123456789ab]'), result);
    } finally {
      fx.cleanup();
    }
  });

  it('fixture G (cross-package limit pin): STEER_MESSAGE_LIMIT matches the bot\'s STEER_MESSAGE_MAX', () => {
    const source = readFileSync(
      join(PKG_ROOT, '..', 'telegram-bot', 'src', 'voice-inbox-steer.ts'),
      'utf8'
    );
    const match = /export const STEER_MESSAGE_MAX = (\d+);/.exec(source);
    assert.ok(match, 'STEER_MESSAGE_MAX not found in projects/telegram-bot/src/voice-inbox-steer.ts');
    assert.equal(
      Number(match![1]),
      STEER_MESSAGE_LIMIT,
      "the bot's STEER_MESSAGE_MAX moved; update STEER_MESSAGE_LIMIT and ROUTE_TEXT_MAX in conversation-briefing.ts and route_task.py"
    );
  });

  it('fixture H (budget arithmetic): briefingBudget is min(cap, ROUTE_TEXT_MAX - baseLength)', () => {
    assert.equal(briefingBudget(3700), 250);
    assert.equal(briefingBudget(1000), CONVERSATION_BRIEFING_MAX);
    assert.equal(briefingBudget(4000), -50);
  });

  it('ledgerPathOf: forward-slashes the sqlite file path better-sqlite3 was opened with', () => {
    const fx = makeFixture();
    try {
      const path = ledgerPathOf(fx.db);
      assert.equal(path.includes('\\'), false, path);
      assert.ok(path.endsWith('/ledger.sqlite'), path);
    } finally {
      fx.cleanup();
    }
  });

  it('buildTargetInjectionTextWithBriefing threads attachments into the target text', () => {
    const fx = makeFixture();
    try {
      seedFixtureA(fx.db);
      const base = {
        taskId: 'vi-cccccccccccc',
        requestText: 'Not Rava. Strava.',
        reason: 'operator reroute',
        repoRoot: '<repo>',
        conversationId: CONVO,
      };
      const without = buildTargetInjectionTextWithBriefing(fx.db, TENANT, base);
      const withSegment = buildTargetInjectionTextWithBriefing(fx.db, TENANT, {
        ...base,
        attachments: ['D:/x/a.png', 'D:/x/b.mp4'],
      });
      assert.ok(withSegment.includes('Attachments (2): D:/x/a.png; D:/x/b.mp4.'), withSegment);
      assert.equal(without.includes('Attachments ('), false, without);
      // The segment sits between the request and the surface sentence.
      assert.ok(
        withSegment.includes('Not Rava. Strava.. Attachments (2): D:/x/a.png; D:/x/b.mp4. Open them from disk'),
        withSegment
      );
    } finally {
      fx.cleanup();
    }
  });
});
