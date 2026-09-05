import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { createTempPaHome, cleanup } from './helpers.js';
import { paHome } from '../src/paths.js';
import {
  appendTask,
  listTasks,
  popTask,
  taskQueuePath,
  taskRunningPath,
  validateTaskPrompt,
  validateTaskTitle,
  claimNextTask,
  parkTask,
  answerTask,
  completeTask,
  failTask,
  deferTask,
  attachQuestionMessage,
  recordFyiMessage,
  listRunningTasks,
  findTaskByAnchorMessage,
  demoteStaleRunningTasks,
  touchTaskActivity,
  TOPIC_TASK_SLOTS,
  TOPIC_TASK_STALE_MS,
  TOPIC_TASK_MAX_ATTEMPTS,
  TOPIC_TASK_RETRY_NOT_BEFORE_MS,
  TOPIC_TASK_ACTIVITY_THROTTLE_MS,
  _resetTopicTasksForTest,
  type TopicTask,
  type RunningTask,
} from '../src/lib/topic-tasks.js';
import { readTopicEvents } from '../src/lib/topic-events.js';

describe('topic-tasks', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempPaHome();
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await cleanup(dir);
  });

  describe('validateTaskPrompt (pure)', () => {
    it('accepts a normal single-line prompt', () => {
      assert.deepEqual(validateTaskPrompt('Report one line: done.'), { ok: true });
    });

    it('rejects an empty or whitespace-only prompt', () => {
      assert.equal(validateTaskPrompt('').ok, false);
      assert.equal(validateTaskPrompt('   ').ok, false);
      assert.equal(
        (validateTaskPrompt('') as { ok: false; error: string }).error,
        'task.prompt must not be empty',
      );
    });

    it('rejects multiline prompt', () => {
      const r = validateTaskPrompt('line one\nline two');
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'task.prompt must be a single line');
      const cr = validateTaskPrompt('line one\rline two');
      assert.equal((cr as { ok: false; error: string }).error, 'task.prompt must be a single line');
    });

    it('rejects oversized prompt', () => {
      const r = validateTaskPrompt('x'.repeat(501));
      assert.equal(r.ok, false);
      assert.equal(
        (r as { ok: false; error: string }).error,
        'task.prompt exceeds 500 characters',
      );
      assert.deepEqual(validateTaskPrompt('x'.repeat(500)), { ok: true });
    });

    it('rejects slash-leading prompt', () => {
      const r = validateTaskPrompt('/run something dangerous');
      assert.equal(r.ok, false);
      assert.equal((r as { ok: false; error: string }).error, 'task.prompt must not start with "/"');
    });
  });

  describe('validateTaskTitle (pure)', () => {
    it('accepts up to 80 single-line chars and rejects beyond', () => {
      assert.deepEqual(validateTaskTitle('x'.repeat(80)), { ok: true });
      const r = validateTaskTitle('x'.repeat(81));
      assert.equal((r as { ok: false; error: string }).error, 'task.title exceeds 80 characters');
    });

    it('rejects an empty or multiline title', () => {
      assert.equal(
        (validateTaskTitle('') as { ok: false; error: string }).error,
        'task.title must not be empty',
      );
      assert.equal(
        (validateTaskTitle('a\nb') as { ok: false; error: string }).error,
        'task.title must be a single line',
      );
    });
  });

  describe('store', () => {
    it('persists to the frozen per-topic path', async () => {
      const p = taskQueuePath(123, 310);
      assert.equal(p, join(paHome(), 'topic-tasks', '123_310.json'));
      const { id } = await appendTask(123, 310, { title: 'T', prompt: 'P', createdBy: 'cli' });
      assert.match(id, /^tt-[0-9a-f]{12}$/);
      const raw = JSON.parse(await readFile(p, 'utf8')) as TopicTask[];
      assert.equal(raw.length, 1);
      assert.equal(raw[0].id, id);
      assert.equal(raw[0].kind, 'task');
      assert.equal(raw[0].created_by, 'cli');
      assert.match(raw[0].content_hash, /^[0-9a-f]{16}$/);
    });

    it('supports negative (supergroup) chat ids in the path', async () => {
      await appendTask(-100123, 310, { title: 'T', prompt: 'P', createdBy: 'cli' });
      assert.equal(taskQueuePath(-100123, 310), join(paHome(), 'topic-tasks', '-100123_310.json'));
      assert.equal((await listTasks(-100123, 310)).length, 1);
    });

    it('appends and pops FIFO', async () => {
      await appendTask(1, 0, { title: 'first', prompt: 'p1', createdBy: 'cli' });
      await appendTask(1, 0, { title: 'second', prompt: 'p2', createdBy: 'cli' });
      await appendTask(1, 0, { title: 'third', prompt: 'p3', createdBy: 'cli' });

      const first = await popTask(1, 0);
      assert.equal(first?.title, 'first');
      const second = await popTask(1, 0);
      assert.equal(second?.title, 'second');
      const third = await popTask(1, 0);
      assert.equal(third?.title, 'third');

      assert.equal(await popTask(1, 0), null);
      assert.deepEqual(await listTasks(1, 0), []);
    });

    it('popTask persists the remainder before returning (pop-first)', async () => {
      await appendTask(1, 0, { title: 'a', prompt: 'p1', createdBy: 'cli' });
      await appendTask(1, 0, { title: 'b', prompt: 'p2', createdBy: 'cli' });

      const popped = await popTask(1, 0);
      assert.equal(popped?.title, 'a');

      // The on-disk queue already reflects the pop the moment popTask resolves.
      const raw = JSON.parse(await readFile(taskQueuePath(1, 0), 'utf8')) as TopicTask[];
      assert.equal(raw.length, 1);
      assert.equal(raw[0].title, 'b');
    });

    it('dedups identical task by content hash', async () => {
      const first = await appendTask(1, 0, {
        title: 'Wave 1 dogfood',
        prompt: 'Report one line: done.',
        createdBy: 'cli',
      });
      assert.equal(first.deduped, false);

      const again = await appendTask(1, 0, {
        title: 'Wave 1 dogfood',
        prompt: 'Report one line: done.',
        createdBy: 'cli',
      });
      assert.equal(again.deduped, true);
      assert.equal(again.id, first.id);
      assert.equal((await listTasks(1, 0)).length, 1);

      // A different prompt (or a different topic) is a different hash.
      const other = await appendTask(1, 0, {
        title: 'Wave 1 dogfood',
        prompt: 'Report one line: done now.',
        createdBy: 'cli',
      });
      assert.equal(other.deduped, false);
      assert.equal((await listTasks(1, 0)).length, 2);
      assert.notEqual(other.id, first.id);
    });

    it('rejects an invalid prompt or title without writing the queue', async () => {
      await assert.rejects(
        appendTask(1, 0, { title: 'T', prompt: 'a\nb', createdBy: 'cli' }),
        /task\.prompt must be a single line/,
      );
      await assert.rejects(
        appendTask(1, 0, { title: '', prompt: 'P', createdBy: 'cli' }),
        /task\.title must not be empty/,
      );
      await assert.rejects(
        appendTask(1, 0, { title: 'T', prompt: 'P', createdBy: '' }),
        /task\.created_by must be a non-empty single line/,
      );
      assert.deepEqual(await listTasks(1, 0), []);
    });

    it('concurrent appends under lock lose no record', async () => {
      const appends = Array.from({ length: 8 }, (_, i) =>
        appendTask(1, 0, { title: `t${i}`, prompt: `p${i}`, createdBy: 'cli' }),
      );
      const results = await Promise.all(appends);

      const ids = new Set(results.map((r) => r.id));
      assert.equal(ids.size, 8);

      const tasks = await listTasks(1, 0);
      assert.equal(tasks.length, 8);
      const raw = JSON.parse(await readFile(taskQueuePath(1, 0), 'utf8')) as TopicTask[];
      assert.equal(raw.length, 8);
    });

    it('listTasks fails to empty on an absent or corrupt queue file', async () => {
      assert.deepEqual(await listTasks(1, 0), []);
      await mkdir(dirname(taskQueuePath(1, 0)), { recursive: true });
      await writeFile(taskQueuePath(1, 0), '{not json', 'utf8');
      assert.deepEqual(await listTasks(1, 0), []);
    });
  });

  // ---------------------------------------------------------------------
  // Wave 2 running store (SPEC §3.1)
  // ---------------------------------------------------------------------

  /** Hand-written running record — for states a real producer cannot create
   *  (stale started_at, attempts at cap). */
  async function writeRawRunning(chatId: number, threadId: number, records: RunningTask[]): Promise<void> {
    await mkdir(dirname(taskRunningPath(chatId, threadId)), { recursive: true });
    await writeFile(taskRunningPath(chatId, threadId), JSON.stringify(records, null, 2), 'utf8');
  }

  function makeRunningRecord(overrides: Partial<RunningTask>): RunningTask {
    return {
      id: `tt-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
      title: 'seeded',
      prompt: 'seeded prompt',
      created_at: new Date().toISOString(),
      created_by: 'cli',
      content_hash: 'deadbeefdeadbeef',
      status: 'running',
      slot: 0,
      started_at: new Date().toISOString(),
      micro_thread: [],
      fyi_message_ids: [],
      question: null,
      attempts: 1,
      ...overrides,
    };
  }

  describe('appendTask worker pin (Wave 2)', () => {
    it('stores an optional worker pin and rejects a malformed one', async () => {
      await appendTask(1, 0, { title: 'pinned', prompt: 'p', createdBy: 'cli', worker: 'agy' });
      const queued = await listTasks(1, 0);
      assert.equal(queued[0].worker, 'agy');
      await assert.rejects(
        appendTask(1, 0, { title: 'bad pin', prompt: 'p', createdBy: 'cli', worker: 'Agy9_x' }),
        /task\.worker must match/,
      );
    });
  });

  describe('running store (Wave 2)', () => {
    it('running store lives at the frozen sibling path', async () => {
      assert.equal(
        taskRunningPath(123, 310),
        join(paHome(), 'topic-tasks', '123_310.running.json'),
      );
      assert.deepEqual(await listRunningTasks(123, 310), [], 'absent store reads as empty');
    });

    it('claimNextTask pops queued into running with free slot', async () => {
      const { id } = await appendTask(1, 0, { title: 'first', prompt: 'p1', createdBy: 'cli', worker: 'agy' });
      const claimed = await claimNextTask(1, 0);
      assert.ok(claimed);
      assert.equal(claimed.id, id);
      assert.equal(claimed.status, 'running');
      assert.equal(claimed.attempts, 1);
      assert.equal(claimed.slot, 0);
      assert.equal(claimed.worker, 'agy', 'the worker pin rides the claim');
      assert.deepEqual(claimed.micro_thread, []);
      assert.deepEqual(await listTasks(1, 0), [], 'the queue was popped');
      assert.equal((await listRunningTasks(1, 0)).length, 1);
    });

    it('claim blocked when slots full leaves queue untouched', async () => {
      // The slot ceiling is now an unreachable backstop (operator directive
      // 2026-09-03), not a governor — real concurrency is paced by the bot's
      // global tick cap + worker pool. This test still proves the backstop
      // mechanism itself works: fill every slot the constant allows (whatever
      // it is) and confirm a claim is blocked, without assuming a fixed ceiling.
      await appendTask(1, 0, { title: 'queued behind full slots', prompt: 'p', createdBy: 'cli' });
      const filler: RunningTask[] = Array.from({ length: TOPIC_TASK_SLOTS }, (_, i) =>
        makeRunningRecord({
          id: `tt-full${String(i).padStart(4, '0')}`,
          slot: i,
          status: i % 2 === 0 ? 'running' : 'parked',
        }),
      );
      await writeRawRunning(1, 0, filler);
      const claimed = await claimNextTask(1, 0);
      assert.equal(claimed, null, 'every slot occupied — nothing claims');
      assert.equal((await listTasks(1, 0)).length, 1, 'the queued record was NOT popped');
    });

    it('ready record resumes before new claim', async () => {
      await appendTask(1, 0, { title: 'queued', prompt: 'p', createdBy: 'cli' });
      await writeRawRunning(1, 0, [
        makeRunningRecord({ id: 'tt-ready00000a', status: 'ready', attempts: 1, created_at: '2026-09-01T00:00:00.000Z' }),
      ]);
      const claimed = await claimNextTask(1, 0);
      assert.ok(claimed);
      assert.equal(claimed.id, 'tt-ready00000a', 'the ready record wins over the queued one');
      assert.equal(claimed.status, 'running');
      assert.equal(claimed.attempts, 2, 'resume increments attempts');
      assert.equal((await listTasks(1, 0)).length, 1, 'the queue was untouched');
    });

    it('stale running record demoted after 30 min', async () => {
      const stale = new Date(Date.now() - 31 * 60_000).toISOString();
      await writeRawRunning(1, 0, [
        makeRunningRecord({ id: 'tt-stale00000a', started_at: stale }),
        makeRunningRecord({ id: 'tt-fresh00000b', slot: 1 }),
      ]);
      const claimed = await claimNextTask(1, 0);
      // The fresh record still occupies slot 1 and the stale one is now ready
      // (not running) — but a ready record IS claimable, so the demoted record
      // resumes in the same claim. Assert the resume proves the demotion.
      assert.ok(claimed);
      assert.equal(claimed.id, 'tt-stale00000a');
      assert.equal(claimed.status, 'running');
      assert.equal(
        claimed.attempts,
        2,
        'stale demotion leaves attempts unchanged (1); the promotion in the same claim adds +1 → 2',
      );
    });

    it('two ready-in-backoff records still fill the slot budget', async () => {
      // §1-correction (adjudicated 2026-09-02): the slot budget counts EVERY
      // stored record — a ready record in retry backoff still holds its slot
      // index, so counting only running+parked would let a queued pop assign
      // a stale slot and take concurrent task dispatches past the intended
      // budget. Promotable ready records always return before the count check,
      // so counting all records never blocks a legitimate claim.
      // The ceiling is now TOPIC_TASK_SLOTS — an unreachable backstop (operator
      // directive 2026-09-03), not a small governed number — so fill it up to
      // the last two slots with inert placeholders first; that keeps the
      // boundary this test exercises reachable without needing TOPIC_TASK_SLOTS
      // real claimed tasks.
      const filler: RunningTask[] = Array.from({ length: TOPIC_TASK_SLOTS - 2 }, (_, i) =>
        makeRunningRecord({ id: `tt-fill${String(i).padStart(4, '0')}`, slot: i, status: 'running' }),
      );
      await writeRawRunning(1, 0, filler);
      await appendTask(1, 0, { title: 'a', prompt: 'p', createdBy: 'cli' });
      await appendTask(1, 0, { title: 'b', prompt: 'p2', createdBy: 'cli' });
      await appendTask(1, 0, { title: 'c', prompt: 'p3', createdBy: 'cli' });
      const ra = await claimNextTask(1, 0);
      const rb = await claimNextTask(1, 0);
      assert.ok(ra);
      assert.ok(rb);
      await deferTask(1, 0, ra!.id, Date.now() + 60_000);
      await deferTask(1, 0, rb!.id, Date.now() + 60_000);
      const afterDefer = await listRunningTasks(1, 0);
      assert.ok(
        afterDefer.filter((r) => r.id === ra!.id || r.id === rb!.id).every((r) => r.status === 'ready'),
        'both records parked into backoff',
      );
      assert.equal(await claimNextTask(1, 0), null, 'backoff records still occupy the slot budget');
      // Exactly the third record is still queued — nothing was popped.
      const queued = await listTasks(1, 0);
      assert.equal(queued.length, 1);
      assert.equal(queued[0].title, 'c');
    });

    it('attempts exhausted fails task', async () => {
      await writeRawRunning(1, 0, [
        makeRunningRecord({ id: 'tt-exhausted0a', status: 'ready', attempts: TOPIC_TASK_MAX_ATTEMPTS }),
      ]);
      const claimed = await claimNextTask(1, 0);
      assert.equal(claimed, null, 'an exhausted ready record is removed, not resumed');
      assert.deepEqual(await listRunningTasks(1, 0), [], 'the record left the running store');
      const events = await readTopicEvents(1, 0);
      const failed = events.filter((e) => e.kind === 'task_failed' && e.ref === 'tt-exhausted0a');
      assert.equal(failed.length, 1, 'the store emits task_failed itself — no caller observes the removal');
      assert.equal(failed[0].detail, 'attempts-exhausted');
    });

    it('retry_not_before defers a ready record until it elapses', async () => {
      const { id } = await appendTask(1, 0, { title: 'retry me', prompt: 'p', createdBy: 'cli' });
      await claimNextTask(1, 0);
      await deferTask(1, 0, id, Date.now() + TOPIC_TASK_RETRY_NOT_BEFORE_MS);
      assert.equal(await claimNextTask(1, 0), null, 'deferred record is not claimable yet');
      assert.equal((await listTasks(1, 0)).length, 0);
      // Elapse the window: the record resumes with attempts+1.
      await deferTask(1, 0, id, Date.now() - 1);
      const resumed = await claimNextTask(1, 0);
      assert.ok(resumed);
      assert.equal(resumed.id, id);
      assert.equal(resumed.attempts, 2);
      assert.equal(resumed.retry_not_before, undefined, 'a resume consumes the retry window');
    });

    it('answerTask appends micro thread and parks to ready', async () => {
      const { id } = await appendTask(1, 0, { title: 'ask me', prompt: 'p', createdBy: 'cli' });
      await claimNextTask(1, 0);
      const parked = await parkTask(1, 0, id, { text: 'A or B?', options: ['A', 'B'] });
      assert.ok(parked);
      assert.equal(parked.status, 'parked');
      assert.deepEqual(parked.question?.options, ['A', 'B']);
      assert.equal(parked.question?.message_id, undefined, 'message id arrives via attachQuestionMessage');

      await attachQuestionMessage(1, 0, id, 4242);
      const answered = await answerTask(1, 0, id, 'Option B');
      assert.ok(answered);
      assert.equal(answered.status, 'ready');
      assert.equal(answered.question, null);
      assert.equal(answered.micro_thread.length, 1);
      assert.equal(answered.micro_thread[0].role, 'user');
      assert.equal(answered.micro_thread[0].text, 'Option B');
      assert.ok(answered.micro_thread[0].ts, 'micro turn carries a timestamp');
      // The answer is claimable again and carries the micro thread forward.
      const resumed = await claimNextTask(1, 0);
      assert.ok(resumed);
      assert.equal(resumed.attempts, 2);
      assert.equal(resumed.micro_thread[0].text, 'Option B');
    });

    it('answerTask on a RUNNING task feeds the micro thread WITHOUT flipping to ready (no double dispatch)', async () => {
      const { id } = await appendTask(1, 0, { title: 'in flight', prompt: 'p', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.ok(claimed);
      const answered = await answerTask(1, 0, id, 'mid-flight steer');
      assert.ok(answered);
      assert.equal(answered.status, 'running', 'the in-flight dispatch keeps the record');
      assert.equal(answered.question, null);
      assert.ok(answered.micro_thread.some((t) => t.text === 'mid-flight steer'));
      // The discriminator: a flipped record would be re-claimed here (the answer
      // would promote it to ready and the next tick would resume it while the
      // first dispatch is still in flight — double dispatch/spend).
      const reclaimed = await claimNextTask(1, 0);
      assert.equal(reclaimed, null, 'a running record is not re-claimable via an answer');
    });

    it('micro_thread caps at the LAST 6 turns', async () => {
      const { id } = await appendTask(1, 0, { title: 'chatty', prompt: 'p', createdBy: 'cli' });
      await claimNextTask(1, 0);
      for (let i = 0; i < 8; i++) {
        await answerTask(1, 0, id, `answer ${i}`);
      }
      const running = await listRunningTasks(1, 0);
      assert.equal(running[0].micro_thread.length, 6);
      assert.equal(running[0].micro_thread[5].text, 'answer 7', 'the OLDEST turns were dropped');
    });

    it('findTaskByAnchorMessage matches fyi and question anchors', async () => {
      const { id } = await appendTask(1, 0, { title: 'anchored', prompt: 'p', createdBy: 'cli' });
      await claimNextTask(1, 0);
      await recordFyiMessage(1, 0, id, 111);
      await parkTask(1, 0, id, { text: 'q?', options: ['a'] });
      await attachQuestionMessage(1, 0, id, 222);
      assert.equal((await findTaskByAnchorMessage(1, 0, 111))?.id, id, 'pickup FYI anchors');
      assert.equal((await findTaskByAnchorMessage(1, 0, 222))?.id, id, 'question keyboard anchors');
      assert.equal(await findTaskByAnchorMessage(1, 0, 999), null);
      await completeTask(1, 0, id);
      assert.equal(await findTaskByAnchorMessage(1, 0, 111), null, 'completeTask removes the anchors too');
    });

    it('fyi anchors cap at the LAST 8 ids', async () => {
      const { id } = await appendTask(1, 0, { title: 'noisy', prompt: 'p', createdBy: 'cli' });
      await claimNextTask(1, 0);
      for (let i = 100; i < 110; i++) {
        await recordFyiMessage(1, 0, id, i);
      }
      const running = await listRunningTasks(1, 0);
      assert.equal(running[0].fyi_message_ids.length, 8);
      assert.deepEqual(running[0].fyi_message_ids, [102, 103, 104, 105, 106, 107, 108, 109], 'the OLDEST anchors were dropped');
    });

    it('completeTask and failTask remove the record and free the slot', async () => {
      const { id } = await appendTask(1, 0, { title: 'doomed', prompt: 'p', createdBy: 'cli' });
      await claimNextTask(1, 0);
      await completeTask(1, 0, id);
      assert.deepEqual(await listRunningTasks(1, 0), []);
      // A failed task frees its slot for the next queued one.
      await appendTask(1, 0, { title: 'next in line', prompt: 'p2', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.equal(claimed?.slot, 0, 'slot 0 was reused after the record left');
      await failTask(1, 0, claimed!.id, 'worker exploded');
      assert.deepEqual(await listRunningTasks(1, 0), []);
    });

    it('slot assignment skips slots still in use', async () => {
      await writeRawRunning(1, 0, [makeRunningRecord({ id: 'tt-taking00s0', slot: 0, status: 'running' })]);
      await appendTask(1, 0, { title: 'fills slot 1', prompt: 'p', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.equal(claimed?.slot, 1);
    });

    it('listRunningTasks fails to empty on a corrupt running file', async () => {
      await mkdir(dirname(taskRunningPath(1, 0)), { recursive: true });
      await writeFile(taskRunningPath(1, 0), '{not json', 'utf8');
      assert.deepEqual(await listRunningTasks(1, 0), []);
    });
  });

  // ---------------------------------------------------------------------
  // WP-A activity-gated demotion + claim generations (adjudicated 2026-09-03):
  // demoteStaleRunningTasks/claimNextTask demote a running record only when it
  // has been SILENT past the stale window — an actively-producing attempt
  // (fresh lastActivityAt heartbeat) is never demoted, however long it runs,
  // because the original worker may still be alive and the demote+re-claim
  // would double-execute the task.
  // ---------------------------------------------------------------------

  describe('activity heartbeat + stale demotion (WP-A)', () => {
    /** Backdate a field on a REAL claimed record — a state no producer API
     *  creates (the stale fixtures). */
    async function editRunning(chatId: number, threadId: number, id: string, mutate: (r: RunningTask) => void): Promise<void> {
      const p = taskRunningPath(chatId, threadId);
      const records = JSON.parse(await readFile(p, 'utf8')) as RunningTask[];
      for (const r of records) {
        if (r.id === id) mutate(r);
      }
      await writeFile(p, JSON.stringify(records, null, 2), 'utf8');
    }

    const longAgo = () => new Date(Date.now() - TOPIC_TASK_STALE_MS - 60_000).toISOString();

    it('claimNextTask stamps claimGen=1 on a fresh claim', async () => {
      await appendTask(1, 0, { title: 'gen one', prompt: 'p', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.equal(claimed?.claimGen, 1);
      assert.equal(claimed?.lastActivityAt, undefined, 'a fresh claim has no heartbeat yet');
    });

    it('actively-streaming record past 30 min is NOT demoted (throttled activity writes honored)', async () => {
      await appendTask(1, 0, { title: 'still producing', prompt: 'p', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.ok(claimed);
      // The executor's heartbeat: one admitted write stamps the record.
      assert.equal(await touchTaskActivity(1, 0, claimed.id), true, 'first heartbeat inside the throttle window is admitted');
      // The claim is 31 min old, but the heartbeat is fresh — the worker may
      // legitimately still be streaming (worker-exec total timeout 60 min).
      await editRunning(1, 0, claimed.id, (r) => { r.started_at = longAgo(); });
      assert.equal(await demoteStaleRunningTasks(1, 0), 0, 'fresh heartbeat blocks the sweep');
      assert.equal(await claimNextTask(1, 0), null, 'and blocks the inline pass — no re-claim, no double dispatch');
      const [record] = await listRunningTasks(1, 0);
      assert.equal(record.status, 'running');
      assert.equal(record.claimGen, 1, 'ownership never changed');
    });

    it('silent record past 30 min (stale lastActivityAt) demotes as before', async () => {
      await appendTask(1, 0, { title: 'went quiet', prompt: 'p', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.ok(claimed);
      assert.equal(await touchTaskActivity(1, 0, claimed.id), true);
      // Activity then stopped: even the heartbeat is now past the window.
      await editRunning(1, 0, claimed.id, (r) => {
        r.started_at = longAgo();
        r.lastActivityAt = longAgo();
      });
      assert.equal(await demoteStaleRunningTasks(1, 0), 1);
      const [record] = await listRunningTasks(1, 0);
      assert.equal(record.status, 'ready');
    });

    it('legacy record without lastActivityAt demotes on started_at age', async () => {
      await writeRawRunning(1, 0, [
        makeRunningRecord({ id: 'tt-legacy000a', started_at: longAgo() }),
      ]);
      assert.equal(await demoteStaleRunningTasks(1, 0), 1, 'absent heartbeat falls back to started_at');
      // The demoted legacy record re-claims with a minted generation.
      const reclaimed = await claimNextTask(1, 0);
      assert.ok(reclaimed);
      assert.equal(reclaimed.claimGen, 1, 'a record without a generation mints 1 on its first re-claim');
      assert.equal(reclaimed.lastActivityAt, undefined, 'the re-claim dropped the stale heartbeat field');
    });

    it('touchTaskActivity is throttled to one write per window', async () => {
      await appendTask(1, 0, { title: 'chatty', prompt: 'p', createdBy: 'cli' });
      const claimed = await claimNextTask(1, 0);
      assert.ok(claimed);
      assert.equal(await touchTaskActivity(1, 0, claimed.id), true);
      // Sabotage the stamp, then hammer: inside the window every call is a no-op.
      await editRunning(1, 0, claimed.id, (r) => { r.lastActivityAt = longAgo(); });
      assert.equal(await touchTaskActivity(1, 0, claimed.id), false, 'second call inside the window is throttled');
      const [record] = await listRunningTasks(1, 0);
      assert.equal(
        Date.parse(record.lastActivityAt!) < Date.now() - TOPIC_TASK_STALE_MS,
        true,
        'the throttled call wrote nothing — the sabotaged (old) stamp survived',
      );
      // After the window elapses, the next heartbeat is admitted again.
      assert.equal(await touchTaskActivity(1, 0, claimed.id, Date.now() + TOPIC_TASK_ACTIVITY_THROTTLE_MS + 1), true);
      assert.equal(
        Date.parse((await listRunningTasks(1, 0))[0].lastActivityAt!) > Date.now() - 1000,
        true,
        'the post-window heartbeat landed',
      );
    });

    it('touchTaskActivity on an unknown id is a no-op (fail-soft, no store churn)', async () => {
      assert.equal(await touchTaskActivity(1, 0, 'tt-nonexistent0'), true, 'absent record: no error, no write');
      assert.deepEqual(await listRunningTasks(1, 0), []);
    });
  });
});
