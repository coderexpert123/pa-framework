import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { appendTopicEvent } from '../src/lib/topic-events.js';
import type { TraceLine } from '../src/lib/ref-lookup.js';
import type { TaskLaneActivity, TaskLaneTask } from '../src/lib/task-lane-activity.js';
import {
  readTaskLaneActivity,
  enrichTaskLaneActivity,
  formatTaskLanePromptSection,
  formatTaskLaneReportLine,
  TASK_LANE_PROMPT_MAX_TASKS,
  TASK_LANE_PROMPT_MAX_TOPICS,
  TASK_LANE_MAX_TRACE_JOINS,
} from '../src/lib/task-lane-activity.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await createTempPaHome();
});

afterEach(async () => {
  await cleanup(tempDir);
});

function topicEventsDir(): string {
  return join(tempDir, 'topic-events');
}

type SeedEvent = Parameters<typeof appendTopicEvent>[2];

/** Seed through the REAL producer (appendTopicEvent) under the temp PA_HOME. */
async function seedReal(chatId: number, threadId: number, events: SeedEvent[]): Promise<void> {
  for (const ev of events) {
    await appendTopicEvent(chatId, threadId, ev);
  }
}

/** Window-edge cases need explicit past timestamps — write raw jsonl lines. */
async function writeRawEvents(chatId: number, threadId: number, lines: string[]): Promise<void> {
  const dir = topicEventsDir();
  await mkdir(dir, { recursive: true });
  const body = lines.map((l) => l + '\n').join('');
  await writeFile(join(dir, `${chatId}_${threadId}.jsonl`), body, 'utf8');
}

function rawEvent(ts: string, kind: string, ref: string | null, detail: string): string {
  return JSON.stringify({ ts, kind, ref, detail });
}

function makeTask(overrides: Partial<TaskLaneTask> = {}): TaskLaneTask {
  return {
    ref: 'tt-x',
    title: 'A task',
    starts: 1,
    completed: false,
    failed: false,
    askedQuestion: false,
    answered: false,
    parked: false,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    traceJoined: false,
    ...overrides,
  };
}

describe('readTaskLaneActivity', () => {
  it('aggregates two topics via the real event producer; counts starts/completed/failed; excludes task_queued and ref-null question_asked', async () => {
    await seedReal(123, 456, [
      { kind: 'task_queued', ref: 'tt-q', detail: 'never started' },
      { kind: 'task_started', ref: 'tt-a', detail: 'Deploy the service' },
      { kind: 'task_started', ref: 'tt-a', detail: 'Deploy the service' },
      { kind: 'task_completed', ref: 'tt-a', detail: 'Deploy the service' },
      { kind: 'question_asked', ref: null, detail: 'operator question' },
      { kind: 'task_started', ref: 'tt-b', detail: 'Back up photos' },
      { kind: 'task_failed', ref: 'tt-b', detail: 'disk full' },
    ]);
    await seedReal(789, 1, [
      { kind: 'task_started', ref: 'tt-c', detail: 'Nightly sync' },
      { kind: 'task_completed', ref: 'tt-c', detail: 'Nightly sync' },
      { kind: 'question_asked', ref: 'tt-c', detail: 'Which credentials?' },
      { kind: 'question_answered', ref: 'tt-c', detail: 'answered' },
    ]);

    const activity = await readTaskLaneActivity({ days: 14 });

    assert.equal(activity.windowDays, 14);
    assert.deepEqual(activity.totals, { tasks: 3, starts: 4, completed: 2, failed: 1 });
    assert.equal(activity.topics.length, 2);

    // Topic order: total task events desc (123_456 kept 5 events vs 789_1's 4).
    assert.deepEqual(
      activity.topics.map((t) => `${t.chatId}_${t.threadId}`),
      ['123_456', '789_1']
    );

    // Tasks within a topic: lastSeenAt desc (tt-b's failure landed after tt-a's completion).
    assert.deepEqual(
      activity.topics[0].tasks.map((t) => t.ref),
      ['tt-b', 'tt-a']
    );

    const ttA = activity.topics[0].tasks.find((t) => t.ref === 'tt-a')!;
    assert.equal(ttA.starts, 2);
    assert.equal(ttA.completed, true);
    assert.equal(ttA.failed, false);
    assert.equal(ttA.title, 'Deploy the service');
    assert.equal(ttA.traceJoined, false);
    assert.equal(ttA.worker, undefined);
    assert.equal(ttA.session_id, undefined);

    const ttB = activity.topics[0].tasks.find((t) => t.ref === 'tt-b')!;
    assert.equal(ttB.starts, 1);
    assert.equal(ttB.failed, true);
    assert.equal(ttB.parked, false);
    assert.equal(ttB.failReason, 'disk full');
    assert.equal(ttB.title, 'Back up photos', 'task_failed does not change the title');

    const ttC = activity.topics[1].tasks.find((t) => t.ref === 'tt-c')!;
    assert.equal(ttC.completed, true);
    assert.equal(ttC.askedQuestion, true);
    assert.equal(ttC.answered, true);

    // task_queued (tt-q) and the ref-null question_asked produced no task rows.
    const refs = activity.topics.flatMap((t) => t.tasks.map((task) => task.ref));
    assert.deepEqual(refs.sort(), ['tt-a', 'tt-b', 'tt-c']);

    // The formatters consume the real read output directly.
    assert.ok(formatTaskLanePromptSection(activity).length > 0);
    assert.equal(
      formatTaskLaneReportLine(activity),
      'Task lane (14d): 3 task(s) across 2 topic(s) — 2 completed, 1 failed.'
    );
  });

  it('respects the window cutoff (boundary inclusive) and drops unparseable timestamps', async () => {
    const nowMs = Date.parse('2026-09-05T10:00:00.000Z');
    const d = (msAgo: number) => new Date(nowMs - msAgo).toISOString();
    await writeRawEvents(100, 200, [
      rawEvent(d(14 * 86400000), 'task_started', 'tt-in', 'boundary event'),
      rawEvent(d(14 * 86400000 + 1000), 'task_started', 'tt-old', 'just too old'),
      rawEvent('not-a-date', 'task_started', 'tt-bad', 'unparseable'),
    ]);

    const activity = await readTaskLaneActivity({ days: 14, nowMs });

    const refs = activity.topics.flatMap((t) => t.tasks.map((x) => x.ref));
    assert.deepEqual(refs, ['tt-in']);
    assert.deepEqual(activity.totals, { tasks: 1, starts: 1, completed: 0, failed: 0 });
  });

  it('tolerates an absent dir, a malformed line amid good ones, and a non-matching filename', async () => {
    const empty = await readTaskLaneActivity({ days: 14 });
    assert.deepEqual(empty.topics, []);
    assert.deepEqual(empty.totals, { tasks: 0, starts: 0, completed: 0, failed: 0 });

    await writeRawEvents(111, 222, [
      '{"ts":"2026-09-05T09:00:00.000Z","kind":"task_started"',
      rawEvent('2026-09-05T09:00:00.000Z', 'task_started', 'tt-good', 'Real task'),
      rawEvent('2026-09-05T09:01:00.000Z', 'task_completed', 'tt-good', 'Real task'),
    ]);
    await writeFile(join(topicEventsDir(), 'notes.txt'), 'not a topic file\n', 'utf8');

    const activity = await readTaskLaneActivity({ days: 14 });
    assert.equal(activity.topics.length, 1, 'notes.txt must be skipped');
    assert.equal(activity.topics[0].tasks.length, 1, 'the malformed line must be skipped');
    assert.equal(activity.topics[0].tasks[0].ref, 'tt-good');
    assert.equal(activity.topics[0].tasks[0].starts, 1);
    assert.equal(activity.topics[0].tasks[0].completed, true);
  });

  it('thread kinds are topic events but NOT task-lane activity — the ACTIVITY_KINDS exclusion, pinned; analyzer parity is a later slice', async () => {
    // The raw writer bypasses the enum on purpose: this pin must hold whatever
    // the enum does — the exclusion lives in ACTIVITY_KINDS, not in parsing.
    // Husk-row caveat: the reader emits one topic row per topic-events FILE
    // even when every event is excluded, so row presence is NOT activity.
    const now = new Date().toISOString();
    await writeRawEvents(123, 456, [
      rawEvent(now, 'thread_spawned', 't-1', 'Sweep logs'),
      rawEvent(now, 'thread_steered', 't-1', 'Sweep logs'),
      rawEvent(now, 'thread_completed', 't-1', 'Sweep logs'),
      rawEvent(now, 'thread_failed', 't-2', 'Sweep logs'),
      rawEvent(now, 'thread_cancelled', 't-2', 'Sweep logs'),
    ]);
    await seedReal(789, 1, [{ kind: 'task_started', ref: 'tt-ctrl', detail: 'Nightly sync' }]);

    const activity = await readTaskLaneActivity({ days: 14 });

    assert.deepEqual(activity.totals, { tasks: 1, starts: 1, completed: 0, failed: 0 });
    assert.equal(activity.topics.length, 2);
    // No ordering assumption between rows: exactly one row carries a task (the
    // 789 control); the 123 row exists as a zero-task husk.
    const withTasks = activity.topics.filter((t) => t.tasks.length > 0);
    assert.equal(withTasks.length, 1);
    assert.equal(withTasks[0].chatId, 789);
    assert.deepEqual(withTasks[0].tasks.map((t) => t.ref), ['tt-ctrl']);
    const husk = activity.topics.find((t) => t.tasks.length === 0);
    assert.ok(husk, 'the all-excluded topic still yields a zero-task husk row');
    assert.equal(husk.chatId, 123);
    assert.equal(husk.threadId, 456);
    assert.ok(
      activity.topics.every((t) => !t.tasks.some((task) => task.ref.startsWith('t-'))),
      'no thread ref leaked into the analyzed set'
    );
  });
});

describe('enrichTaskLaneActivity', () => {
  it('joins failed tasks first, then lastSeenAt desc; honors the cap exactly (11 tasks, 10 lookups); returns a NEW object', async () => {
    const calls: string[] = [];
    const lookup = async (ref: string): Promise<TraceLine | null> => {
      calls.push(ref);
      return { run_id: `run-${ref}`, worker: 'agy', session_id: `sess-${ref}` };
    };

    // 11 tasks in one topic; the FAILED task is the OLDEST — pure lastSeenAt-desc
    // selection would drop it, failed-first must keep it.
    const tasks: TaskLaneTask[] = [];
    for (let i = 0; i < 11; i++) {
      tasks.push(
        makeTask({
          ref: `tt-${String(i).padStart(2, '0')}`,
          lastSeenAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 60000).toISOString(),
          failed: i === 0,
          failReason: i === 0 ? 'boom' : undefined,
        })
      );
    }
    const activity: TaskLaneActivity = {
      windowDays: 14,
      topics: [{ chatId: 1, threadId: 2, tasks }],
      totals: { tasks: 11, starts: 11, completed: 0, failed: 1 },
    };

    const enriched = await enrichTaskLaneActivity(activity, lookup);

    assert.equal(calls.length, TASK_LANE_MAX_TRACE_JOINS);
    assert.deepEqual(calls, [
      'tt-00',
      'tt-10',
      'tt-09',
      'tt-08',
      'tt-07',
      'tt-06',
      'tt-05',
      'tt-04',
      'tt-03',
      'tt-02',
    ]);

    const joined = enriched.topics[0].tasks.filter((t) => t.traceJoined).map((t) => t.ref);
    assert.equal(joined.length, TASK_LANE_MAX_TRACE_JOINS);
    assert.ok(joined.includes('tt-00'), 'the failed task must be joined first');
    assert.deepEqual(
      enriched.topics[0].tasks.filter((t) => !t.traceJoined).map((t) => t.ref),
      ['tt-01'],
      'the oldest non-failed task is the one dropped'
    );

    const tt00 = enriched.topics[0].tasks.find((t) => t.ref === 'tt-00')!;
    assert.equal(tt00.worker, 'agy');
    assert.equal(tt00.session_id, 'sess-tt-00');
    assert.equal(tt00.traceJoined, true);

    // The input object is consumed, not mutated.
    const inputTt00 = activity.topics[0].tasks.find((t) => t.ref === 'tt-00')!;
    assert.equal(inputTt00.worker, undefined);
    assert.equal(inputTt00.session_id, undefined);
    assert.equal(inputTt00.traceJoined, false);
  });

  it('degrades gracefully: a throwing lookup leaves traceJoined false without throwing; non-string trace fields stay unset', async () => {
    const activity: TaskLaneActivity = {
      windowDays: 14,
      topics: [
        {
          chatId: 5,
          threadId: 6,
          tasks: [makeTask({ ref: 'tt-throw', failed: true, failReason: 'x' }), makeTask({ ref: 'tt-nonstring' })],
        },
      ],
      totals: { tasks: 2, starts: 2, completed: 0, failed: 1 },
    };
    const lookup = async (ref: string): Promise<TraceLine | null> => {
      if (ref === 'tt-throw') throw new Error('trace sidecar unreadable');
      return { run_id: 'r1', worker: 42, session_id: 'sess-9' };
    };

    const enriched = await enrichTaskLaneActivity(activity, lookup);

    const threw = enriched.topics[0].tasks.find((t) => t.ref === 'tt-throw')!;
    assert.equal(threw.traceJoined, false);
    assert.equal(threw.worker, undefined);
    assert.equal(threw.session_id, undefined);

    const nonstring = enriched.topics[0].tasks.find((t) => t.ref === 'tt-nonstring')!;
    assert.equal(nonstring.traceJoined, true);
    assert.equal(nonstring.worker, undefined, 'worker 42 is not a string → unset');
    assert.equal(nonstring.session_id, 'sess-9');
  });
});

describe('formatTaskLanePromptSection', () => {
  it('renders the exact section for the fixed 1-topic/2-task fixture, joined worker/session halves included', () => {
    const activity: TaskLaneActivity = {
      windowDays: 14,
      topics: [
        {
          chatId: 123,
          threadId: 456,
          tasks: [
            makeTask({
              ref: 'tt-a',
              title: 'Deploy the service',
              starts: 2,
              completed: true,
              worker: 'agy',
              session_id: 'sess-123',
              traceJoined: true,
            }),
            makeTask({
              ref: 'tt-b',
              title: 'Failing task',
              starts: 1,
              failed: true,
              failReason: 'disk full',
            }),
          ],
        },
      ],
      totals: { tasks: 2, starts: 3, completed: 1, failed: 1 },
    };

    const expected = [
      '## Async task-lane activity (last 14 days)',
      '',
      "Task-lane executions with their conversation (<chatId>_<threadId> = topic thread). A task's",
      'session is the worker conversation that executed it.',
      '- 123_456: Deploy the service — started 2x, outcome: completed, worker agy, session sess-123',
      '- 123_456: Failing task — started 1x, outcome: failed (disk full), worker unknown, session unknown',
    ].join('\n');
    assert.equal(formatTaskLanePromptSection(activity), expected);
  });

  it("returns '' for undefined and for zeroed activity", () => {
    assert.equal(formatTaskLanePromptSection(undefined), '');
    const zeroed: TaskLaneActivity = {
      windowDays: 14,
      topics: [],
      totals: { tasks: 0, starts: 0, completed: 0, failed: 0 },
    };
    assert.equal(formatTaskLanePromptSection(zeroed), '');
  });

  it('caps: (+1 more task(s) not shown) when a 13th task exists; only the first 6 topics render', () => {
    const tasks13 = Array.from({ length: TASK_LANE_PROMPT_MAX_TASKS + 1 }, (_, i) =>
      makeTask({
        ref: `tt-${i}`,
        title: `Task ${i}`,
        lastSeenAt: new Date(Date.parse('2026-09-01T00:00:00.000Z') - i * 60000).toISOString(),
      })
    );
    const activity13: TaskLaneActivity = {
      windowDays: 14,
      topics: [{ chatId: 1, threadId: 2, tasks: tasks13 }],
      totals: { tasks: 13, starts: 13, completed: 0, failed: 0 },
    };
    const section13 = formatTaskLanePromptSection(activity13);
    assert.equal(section13.split('\n').filter((l) => l.startsWith('- ')).length, TASK_LANE_PROMPT_MAX_TASKS);
    assert.ok(section13.endsWith('(+1 more task(s) not shown)'));

    const topics7 = Array.from({ length: 7 }, (_, i) => ({
      chatId: i + 1,
      threadId: 100 + i,
      tasks: [makeTask({ ref: `tt-t${i}`, title: `Topic task ${i}` })],
    }));
    const activity7: TaskLaneActivity = {
      windowDays: 14,
      topics: topics7,
      totals: { tasks: 7, starts: 7, completed: 0, failed: 0 },
    };
    const section7 = formatTaskLanePromptSection(activity7);
    assert.equal(section7.split('\n').filter((l) => l.startsWith('- ')).length, TASK_LANE_PROMPT_MAX_TOPICS);
    assert.ok(section7.endsWith('(+1 more task(s) not shown)'));
    assert.ok(section7.includes('- 6_105: Topic task 5'));
    assert.ok(!section7.includes('Topic task 6'));
  });

  it('selects the outcome word by the fixed precedence: failed > completed > question asked > question answered > parked/open > open', () => {
    const section = formatTaskLanePromptSection({
      windowDays: 14,
      topics: [
        {
          chatId: 9,
          threadId: 9,
          tasks: [
            makeTask({ ref: 'tt-f', title: 'F', failed: true, failReason: 'x', completed: true, askedQuestion: true, answered: true, parked: true }),
            makeTask({ ref: 'tt-c', title: 'C', completed: true, askedQuestion: true, answered: true, parked: true }),
            makeTask({ ref: 'tt-qa', title: 'QA', askedQuestion: true, answered: true, parked: true }),
            makeTask({ ref: 'tt-an', title: 'AN', answered: true, parked: true }),
            makeTask({ ref: 'tt-p', title: 'P', parked: true }),
            makeTask({ ref: 'tt-o', title: 'O' }),
          ],
        },
      ],
      totals: { tasks: 6, starts: 6, completed: 0, failed: 0 },
    });
    const bullets = section.split('\n').filter((l) => l.startsWith('- '));
    assert.ok(bullets[0].includes('outcome: failed (x)'));
    assert.ok(bullets[1].includes('outcome: completed'));
    assert.ok(bullets[2].includes('outcome: question asked'));
    assert.ok(bullets[3].includes('outcome: question answered'));
    assert.ok(bullets[4].includes('outcome: parked/open'));
    assert.ok(bullets[5].includes('outcome: open'));
  });
});

describe('formatTaskLaneReportLine', () => {
  it('renders the exact report line for the same fixture', () => {
    const activity: TaskLaneActivity = {
      windowDays: 14,
      topics: [
        {
          chatId: 123,
          threadId: 456,
          tasks: [
            makeTask({ ref: 'tt-a', title: 'Deploy the service', starts: 2, completed: true, worker: 'agy', session_id: 'sess-123', traceJoined: true }),
            makeTask({ ref: 'tt-b', title: 'Failing task', starts: 1, failed: true, failReason: 'disk full' }),
          ],
        },
      ],
      totals: { tasks: 2, starts: 3, completed: 1, failed: 1 },
    };
    assert.equal(
      formatTaskLaneReportLine(activity),
      'Task lane (14d): 2 task(s) across 1 topic(s) — 1 completed, 1 failed.'
    );
  });

  it('returns null for undefined and for zeroed activity', () => {
    assert.equal(formatTaskLaneReportLine(undefined), null);
    const zeroed: TaskLaneActivity = {
      windowDays: 14,
      topics: [],
      totals: { tasks: 0, starts: 0, completed: 0, failed: 0 },
    };
    assert.equal(formatTaskLaneReportLine(zeroed), null);
  });
});

describe('read → enrich → format chain (real producer output)', () => {
  it('renders the joined worker/session into the section and the report line', async () => {
    await seedReal(555, 1, [
      { kind: 'task_started', ref: 'tt-x', detail: 'Chain task' },
      { kind: 'task_failed', ref: 'tt-x', detail: 'boom' },
    ]);
    const read = await readTaskLaneActivity({ days: 14 });
    const enriched = await enrichTaskLaneActivity(read, async (ref) => ({
      run_id: `run-${ref}`,
      worker: 'agy',
      session_id: 'sess-chain',
    }));
    const section = formatTaskLanePromptSection(enriched);
    assert.ok(
      section.includes('- 555_1: Chain task — started 1x, outcome: failed (boom), worker agy, session sess-chain'),
      `section should carry the joined bullet, got:\n${section}`
    );
    assert.equal(
      formatTaskLaneReportLine(enriched),
      'Task lane (14d): 1 task(s) across 1 topic(s) — 0 completed, 1 failed.'
    );
  });
});
