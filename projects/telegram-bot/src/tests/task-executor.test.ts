// Wave-2 executor core tests (SPEC §3.1 A.3, plans/2026-09-02-topic-handover-WAVE2-SPEC.md):
// executeTopicTask's full ladder (completion FYI, question park, retry/terminal
// failure), buildTaskPrompt shape, and the tier-1 routeReplyToTask hook — every case
// drives the REAL store chain (appendTask → claimNextTask) under a sandboxed PA_HOME.
// MUST stay first — sandboxes PA_HOME against real side effects (test-env-guard contract).
import './test-env-guard.js';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildTaskPrompt,
  executeTopicTask,
  routeReplyToTask,
  TASK_RESPONSE_CAP_CHARS,
  TASK_RULES,
  _setActivityPumpIntervalForTest,
  type ExecuteTopicTaskArgs,
} from '../task-executor.js';
import {
  appendTask,
  claimNextTask,
  listRunningTasks,
  parkTask,
  recordFyiMessage,
  taskRunningPath,
  TOPIC_TASK_ACTIVITY_THROTTLE_MS,
  TOPIC_TASK_MAX_ATTEMPTS,
  TOPIC_TASK_RETRY_NOT_BEFORE_MS,
  TOPIC_TASK_STALE_MS,
  _resetTopicTasksForTest,
  type RunningTask,
} from '../../../../pa/dist/src/lib/topic-tasks.js';
import { readTopicEvents } from '../../../../pa/dist/src/lib/topic-events.js';
import { flushLog } from '../../../../pa/dist/src/lib/log.js';
import type { CommandResult } from '../../../../pa/dist/src/types.js';

const CHAT_ID = -1001234567890;
const THREAD_ID = 5001;

/** REAL producer chain: queue via appendTask, claim into the running store. */
async function claimedTask(title = 'T', prompt = 'do things', worker?: string): Promise<RunningTask> {
  await appendTask(CHAT_ID, THREAD_ID, { title, prompt, createdBy: 'cli', ...(worker ? { worker } : {}) });
  const claimed = await claimNextTask(CHAT_ID, THREAD_ID);
  assert.ok(claimed, 'fixture claim must succeed');
  return claimed;
}

type FyiCapture = Array<{ text: string; kind: string; keyboard: any }>;

function makeSendFyi(capture: FyiCapture, messageId: number | null = 31337) {
  return async (text: string, kind: string, keyboard?: any): Promise<number | null> => {
    capture.push({ text, kind, keyboard: keyboard ?? null });
    return messageId;
  };
}

function makeArgs(
  task: RunningTask,
  overrides: Partial<ExecuteTopicTaskArgs> = {}
): ExecuteTopicTaskArgs {
  return {
    task,
    topicCtx: { chatId: CHAT_ID, threadId: THREAD_ID, topicName: 'Handover Sandbox' },
    secrets: {},
    token: '',
    workdir: { dir: join(tmpdir(), 'task-executor-unused-cwd') },
    sendFyi: makeSendFyi([]),
    ...overrides,
  };
}

function okDispatch(output: string, worker = 'agy') {
  return async (): Promise<{ worker: string; result: CommandResult }> => ({
    worker,
    result: { success: true, output, exitCode: 0 },
  });
}

function failDispatch(error = 'boom'): () => Promise<{ worker: string; result: CommandResult }> {
  return async () => ({ worker: 'agy', result: { success: false, output: '', error, exitCode: 1 } });
}

/** The PA_META envelope as a worker's last output line. */
function metaOutput(cleaned: string, actions: unknown[]): string {
  return `${cleaned}\n[PA_META]: ${JSON.stringify({ actions })}`;
}

describe('buildTaskPrompt', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'task-executor-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await flushLog();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('embeds title, attempt counter, micro thread and the frozen rule block', async () => {
    const task = await claimedTask('Ship the report', 'write the quarterly report');
    task.micro_thread = [
      { role: 'user', text: 'start it', ts: new Date().toISOString() },
      { role: 'assistant', text: 'on it', ts: new Date().toISOString() },
    ];
    const prompt = await buildTaskPrompt(task, {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      topicName: 'Handover Sandbox',
    });
    assert.match(prompt, /^You are executing a queued task in topic "Handover Sandbox"/);
    assert.match(prompt, /Task: Ship the report\n/);
    assert.match(prompt, new RegExp(`Attempt ${task.attempts}/${TOPIC_TASK_MAX_ATTEMPTS}`));
    assert.match(prompt, /- user: start it\n- assistant: on it/);
    assert.match(prompt, /## Your task\nwrite the quarterly report\n/);
    assert.ok(prompt.includes('## Rules\n' + TASK_RULES), 'the frozen rule block rides verbatim');
    assert.ok(!prompt.includes('## In-flight sibling tasks'), 'no siblings section when the task is alone');
    // renderOpenItems lists the WHOLE running store, so the claimed task itself
    // renders under the in-flight lines (duplication with the "Task:" line is
    // spec-literal skeleton behavior — only the SIBLINGS section excludes self).
    assert.ok(prompt.includes('## Open items (short-term)'));
    assert.ok(
      new RegExp(`- ${task.id} — Ship the report \\(running, attempt 1/${TOPIC_TASK_MAX_ATTEMPTS}\\)`).test(prompt),
      'the claimed task renders as an in-flight open item'
    );
    assert.ok(!prompt.includes('Queued tasks'), 'no queued block — the only task was claimed');
  });

  it('renders in-flight siblings (never the task itself)', async () => {
    const task = await claimedTask('solo task', 'the prompt text');
    const sibling = await claimedTask('sibling task', 'other work');
    const prompt = await buildTaskPrompt(task, {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      topicName: 'Handover Sandbox',
    });
    const section = prompt.split('## In-flight sibling tasks')[1]?.split('## Your task')[0] ?? '';
    assert.match(
      section,
      new RegExp(`- ${sibling.id} — sibling task \\(running\\)`),
      'one line per sibling with id, title, status'
    );
    assert.ok(!section.includes(task.id), 'the executing task never lists itself in the SIBLINGS section');
  });
});

describe('executeTopicTask', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'task-executor-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await flushLog();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('success output → completion FYI, record completed, task_completed event, refreshCard chained', async () => {
    const task = await claimedTask('Ship the report', 'write it');
    const capture: FyiCapture = [];
    let refreshes = 0;
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch('All done'),
      sendFyi: makeSendFyi(capture),
      refreshCard: async () => { refreshes += 1; },
    }));
    assert.equal(capture.length, 1, 'exactly one FYI (the completion)');
    assert.equal(capture[0].kind, 'task-done');
    assert.equal(capture[0].text, '✅ Task done: Ship the report\n\nAll done');
    assert.deepEqual(await listRunningTasks(CHAT_ID, THREAD_ID), [], 'the record left the running store');
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const done = events.filter((e) => e.kind === 'task_completed' && e.ref === task.id);
    assert.equal(done.length, 1);
    assert.equal(done[0].detail, 'Ship the report');
    assert.equal(refreshes, 1, 'ONE card refresh chained after the terminal state');
  });

  it('PA_META question parks the task with the qt: keyboard and RETURNS (no completion FYI)', async () => {
    const task = await claimedTask('needs a pick', 'choose something');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch(metaOutput('Need your input', [
        { type: 'question', text: 'Pick one', options: ['Option A', 'Option B'] },
      ])),
      sendFyi: makeSendFyi(capture, 777),
      refreshCard: async () => {},
    }));
    assert.equal(capture.length, 1, 'question FYI only — the task is parked, not done');
    assert.equal(capture[0].kind, 'task-question');
    assert.equal(capture[0].text, '❓ Pick one');
    assert.deepEqual(capture[0].keyboard.inline_keyboard, [
      [{ text: 'Option A', callback_data: `qt:${task.id}:0` }],
      [{ text: 'Option B', callback_data: `qt:${task.id}:1` }],
    ], 'one button per option, qt:<taskId>:<idx>');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.status, 'parked');
    assert.deepEqual(record.question, {
      text: 'Pick one',
      options: ['Option A', 'Option B'],
      message_id: 777,
    }, 'the FYI message id is the question anchor');
    assert.ok(record.fyi_message_ids.includes(777), 'question FYI id also recorded as a tier-1 fyi anchor');
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const parked = events.filter((e) => e.kind === 'task_parked' && e.ref === task.id);
    assert.equal(parked.length, 1);
    assert.equal(parked[0].detail, 'Pick one');
  });

  it('question action carrying a foreign task_id is ignored — the run completes normally', async () => {
    const task = await claimedTask('mismatch probe', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch(metaOutput('Done anyway', [
        { type: 'question', task_id: 'tt-000000000000', text: 'not mine', options: ['A'] },
      ])),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 1);
    assert.equal(capture[0].kind, 'task-done', 'the foreign question was skipped, run completed');
    assert.equal(capture[0].text, '✅ Task done: mismatch probe\n\nDone anyway');
    assert.deepEqual(await listRunningTasks(CHAT_ID, THREAD_ID), []);
  });

  it('confirm_required rejected on task lane with notice', async () => {
    const task = await claimedTask('confirm probe', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch(metaOutput('Wrote the file', [
        { type: 'confirm_required', description: 'about to push' },
      ])),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 1, 'no question/confirm keyboard — completion FYI only');
    assert.equal(capture[0].kind, 'task-done');
    assert.ok(
      capture[0].text.includes("_(action 'confirm_required' is not available on the task lane)_"),
      'the unavailable-action notice rides the completion FYI'
    );
    assert.ok(capture[0].text.includes('Wrote the file'));
    assert.deepEqual(await listRunningTasks(CHAT_ID, THREAD_ID), [], 'the run still COMPLETED');
  });

  it('completion FYI caps response at 3500 chars', async () => {
    const task = await claimedTask('caps probe', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch('x'.repeat(4000)),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 1);
    assert.equal(capture[0].text, `✅ Task done: caps probe\n\n${'x'.repeat(TASK_RESPONSE_CAP_CHARS)}…`);
  });

  it('completion FYI normalizes worker markdown (### and ** → MarkdownV2)', async () => {
    const task = await claimedTask('normalize probe', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch('### Verification Summary\n\n**Configuration Resolution** done'),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 1);
    assert.equal(
      capture[0].text,
      '✅ Task done: normalize probe\n\n*Verification Summary*\n\n*Configuration Resolution* done'
    );
  });

  it('retry ladder: failed dispatch defers with backoff + retry FYI (attempts under the cap)', async () => {
    const task = await claimedTask('flaky task', 'the prompt text');
    const capture: FyiCapture = [];
    const before = Date.now();
    await executeTopicTask(makeArgs(task, { dispatch: failDispatch('boom'), sendFyi: makeSendFyi(capture) }));
    const after = Date.now();
    assert.equal(capture.length, 1);
    assert.equal(capture[0].kind, 'task-retry');
    assert.equal(capture[0].text, '⏳ Task hit a snag — retrying automatically: flaky task');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.status, 'ready', 'deferred back to ready for the next tick');
    const notBefore = record.retry_not_before!;
    assert.ok(notBefore >= before + TOPIC_TASK_RETRY_NOT_BEFORE_MS - 1000, 'backoff pinned at 10 min');
    assert.ok(notBefore <= after + TOPIC_TASK_RETRY_NOT_BEFORE_MS + 1000);
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    assert.equal(events.filter((e) => e.kind === 'task_failed').length, 0, 'not terminal yet');
  });

  it('empty output on a successful exit is a failure (requireNonEmptyOutput semantics)', async () => {
    const task = await claimedTask('quiet task', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: async () => ({ worker: 'agy', result: { success: true, output: '   ', exitCode: 0 } }),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture[0].kind, 'task-retry', 'empty output rides the same retry ladder');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.status, 'ready');
  });

  it('AI-202 sixth site: contentless launched/waiting promise rides the retry ladder, never the completion FYI', async () => {
    const task = await claimedTask('promise task', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch('I have launched the git log check and will review the output once it completes.'),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 1, 'no completion FYI — the promise is suppressed');
    assert.equal(capture[0].kind, 'task-retry', 'premature reply rides the same retry ladder as empty output');
    assert.ok(!capture[0].text.includes('launched'), 'the promise text never reaches the topic');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.status, 'ready', 'deferred back to ready for the next tick');
  });

  it('AI-202 sixth site veto: a promise that carries real content still completes normally', async () => {
    const task = await claimedTask('verbose task', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch('I have launched the check and will review it once it completes.\n\nResults so far in C:/tmp/out.txt — 3 issues found.'),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture[0].kind, 'task-done', 'deliverable content is never suppressed');
  });

  it('terminal failure: failed FYI, record removed, task_failed event', async () => {
    const task = await claimedTask('doomed task', 'the prompt text');
    const capture: FyiCapture = [];
    let refreshes = 0;
    await executeTopicTask(makeArgs(task, {
      task: { ...task, attempts: TOPIC_TASK_MAX_ATTEMPTS },
      dispatch: failDispatch('boom'),
      sendFyi: makeSendFyi(capture),
      refreshCard: async () => { refreshes += 1; },
    }));
    assert.equal(capture.length, 1);
    assert.equal(capture[0].kind, 'task-failed');
    assert.equal(capture[0].text, `❌ Task failed after ${TOPIC_TASK_MAX_ATTEMPTS} attempts: doomed task`);
    assert.deepEqual(await listRunningTasks(CHAT_ID, THREAD_ID), [], 'terminal failure frees the slot');
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const failed = events.filter((e) => e.kind === 'task_failed' && e.ref === task.id);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].detail, 'boom');
    assert.equal(refreshes, 1, 'failure is a terminal state — card refresh chained');
  });

  it('worker pin rides the dispatch: the pinned task object reaches the dispatcher', async () => {
    // Verifiable here: the task (with its pin) reaches the dispatch seam intact.
    // The DEFAULT path's `preferredWorker: task.worker` option on runWithFailover is
    // a one-line pass-through that cannot be intercepted from this ESM graph (pa is
    // CJS; require-cache patches are invisible through the compiled-ESM import
    // binding) — verified by inspection, disclosed in the WP-A report.
    const task = await claimedTask('pinned task', 'the prompt text', 'zclaude');
    const capture: FyiCapture = [];
    const seen: { prompt: string; task: RunningTask | null } = { prompt: '', task: null };
    await executeTopicTask(makeArgs(task, {
      dispatch: async (prompt, t) => {
        seen.prompt = prompt;
        seen.task = t;
        return { worker: 'agy', result: { success: true, output: 'ok', exitCode: 0 } };
      },
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(seen.task?.worker, 'zclaude', 'the task carries its worker pin into dispatch');
    assert.ok(seen.prompt.includes('## Your task\nthe prompt text'), 'the built prompt is what dispatches');
    assert.equal(capture[0].kind, 'task-done', 'the run completed normally');
  });

  // Secret-egress rule (wave deep-recheck 2026-09-03): the task lane's FYIs are
  // raw worker output and NEVER pass through formatWorkerReply (where the human
  // lane redacts) and never persist to state.turns — so the executor itself must
  // redact before send. Generic token shapes keep these tests independent of the
  // real secrets.env.
  const TOKEN = 'sk-abcdef0123456789abcdef0123';

  it('completion FYI redacts worker output (secret egress)', async () => {
    const task = await claimedTask('leaky task', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch(`Report ready. Credential: ${TOKEN} — rotate it.`),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture[0].kind, 'task-done');
    assert.ok(capture[0].text.includes('<redacted:token>'), 'the token shape is scrubbed');
    assert.ok(!capture[0].text.includes(TOKEN), 'the raw token never reaches the FYI');
  });

  it('question text and options are redacted before the FYI, the keyboard and the store', async () => {
    const task = await claimedTask('leaky question', 'the prompt text');
    // Runtime-constructed so no literal token shape rides a diff line: the CI PII
    // scan flags literal xoxb- shapes in CHANGED lines even when fake (the local
    // redactor still sees the full shape at runtime — that is what this tests).
    const SLACK_TOKEN_SHAPE = 'xox' + 'b-test1234567890';
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      dispatch: okDispatch(metaOutput(`Need input for ${TOKEN}`, [
        { type: 'question', text: `Deploy key ${TOKEN} — keep?`, options: ['Yes', SLACK_TOKEN_SHAPE] },
      ])),
      sendFyi: makeSendFyi(capture, 888),
      refreshCard: async () => {},
    }));
    assert.equal(capture[0].kind, 'task-question');
    assert.equal(capture[0].text, '❓ Deploy key <redacted:token> — keep?', 'the question FYI is scrubbed');
    const labels = capture[0].keyboard.inline_keyboard.map((row: Array<{ text: string }>) => row[0].text);
    assert.deepEqual(labels, ['Yes', '<redacted:token>'], 'button labels are scrubbed');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.question?.text, 'Deploy key <redacted:token> — keep?', 'the stored question is scrubbed');
    assert.deepEqual(record.question?.options, ['Yes', '<redacted:token>'], 'the stored options are scrubbed');
  });

  it('failure reason is redacted in the task_failed event detail', async () => {
    const task = await claimedTask('doomed loud task', 'the prompt text');
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(task, {
      task: { ...task, attempts: TOPIC_TASK_MAX_ATTEMPTS },
      dispatch: failDispatch(`Boom: Bearer abcdefghijklmnopqrstuvwxyz123 leaked`),
      sendFyi: makeSendFyi(capture),
    }));
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const failed = events.filter((e) => e.kind === 'task_failed' && e.ref === task.id);
    assert.equal(failed.length, 1);
    assert.ok(failed[0].detail.includes('<redacted:token>'), 'the bearer shape is scrubbed at rest');
    assert.ok(!failed[0].detail.includes('abcdefghijklmnopqrstuvwxyz123'), 'the raw secret never lands in the event');
  });
});

// ---------------------------------------------------------------------------
// WP-B claim-ownership recheck (adjudicated 2026-09-03): a running record
// demoted at 30 min while the ORIGINAL worker is still producing gets
// re-claimed by a second attempt — the superseded attempt's late result must
// be discarded silently (no FYI, no ladder, no store mutation), and the
// current owner's terminal path must be untouched by the recheck.
// ---------------------------------------------------------------------------

describe('executeTopicTask claim-ownership recheck (WP-B)', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'task-executor-supersede-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await flushLog();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Hand-edit the running store for a state no real producer creates: a claim
   *  whose started_at is past the stale window (the demote+re-claim fixture). */
  async function backdateStartedAt(chatId: number, threadId: number, id: string): Promise<void> {
    const p = taskRunningPath(chatId, threadId);
    const records = JSON.parse(await readFile(p, 'utf8')) as RunningTask[];
    for (const r of records) {
      if (r.id === id) r.started_at = new Date(Date.now() - TOPIC_TASK_STALE_MS - 60_000).toISOString();
    }
    await writeFile(p, JSON.stringify(records, null, 2), 'utf8');
  }

  /** The REAL double-dispatch sequence: demote the stale claim via the drain's
   *  own classifier, then re-claim — attempt 2 now owns the record. */
  async function demoteAndReclaim(task: RunningTask): Promise<RunningTask> {
    await backdateStartedAt(CHAT_ID, THREAD_ID, task.id);
    const reclaimed = await claimNextTask(CHAT_ID, THREAD_ID);
    assert.ok(reclaimed, 'the demoted record was re-claimed');
    assert.equal(reclaimed.id, task.id);
    assert.notEqual(reclaimed.claimGen, task.claimGen, 'the re-claim minted a new claim generation');
    return reclaimed;
  }

  it('superseded attempt: late completion sends NO FYI, mutates nothing, logs the supersession', async () => {
    const stale = await claimedTask('stale producer', 'the prompt text');
    const reclaimed = await demoteAndReclaim(stale);
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(stale, {
      dispatch: okDispatch('late result from the still-running first worker'),
      sendFyi: makeSendFyi(capture),
      refreshCard: async () => { throw new Error('superseded attempt must not touch the card'); },
    }));
    assert.equal(capture.length, 0, 'no completion FYI from the superseded attempt');
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    assert.equal(
      events.filter((e) => e.kind === 'task_completed' && e.ref === stale.id).length,
      0,
      'no task_completed event from the superseded attempt',
    );
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.ok(record, 'the record is untouched — still owned by attempt 2');
    assert.equal(record.claimGen, reclaimed.claimGen);
    assert.equal(record.status, 'running', 'the current owner still holds the record');
  });

  it('superseded attempt: late FAILURE sends no retry/fail FYI and does not defer or remove the record', async () => {
    const stale = await claimedTask('stale loser', 'the prompt text');
    const reclaimed = await demoteAndReclaim(stale);
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(stale, {
      dispatch: failDispatch('late boom from the first worker'),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 0, 'no retry FYI from the superseded attempt');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.ok(record, 'no defer/fail mutation — the record still belongs to attempt 2');
    assert.equal(record.status, 'running', 'the re-claimed owner was not demoted to ready by a dead attempt');
    assert.equal(record.attempts, reclaimed.attempts, 'the ladder was not advanced by the superseded attempt');
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    assert.equal(events.filter((e) => e.kind === 'task_failed' && e.ref === stale.id).length, 0);
  });

  it('current owner after a demote+re-claim cycle: completion FYI sends normally (recheck does not false-positive)', async () => {
    const stale = await claimedTask('honest reclaim', 'the prompt text');
    const reclaimed = await demoteAndReclaim(stale);
    const capture: FyiCapture = [];
    await executeTopicTask(makeArgs(reclaimed, {
      dispatch: okDispatch('attempt 2 finished it'),
      sendFyi: makeSendFyi(capture),
    }));
    assert.equal(capture.length, 1);
    assert.equal(capture[0].kind, 'task-done');
    assert.equal(capture[0].text, '✅ Task done: honest reclaim\n\nattempt 2 finished it');
    assert.deepEqual(await listRunningTasks(CHAT_ID, THREAD_ID), [], 'the current owner completed the record');
  });
});

// ---------------------------------------------------------------------------
// WP-A activity pump (adjudicated option B): the executor heartbeats the
// running record while its dispatch is pending — the load-bearing half that
// keeps an actively-running attempt out of the stale sweep. Real timers, not
// mock timers: the store's ~10s write throttle is real-time, so only a
// shortened REAL pump period can drive observable heartbeats (and expose a
// leaked pump) inside a test's duration.
// ---------------------------------------------------------------------------

describe('executeTopicTask activity pump (WP-A)', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'task-executor-pump-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await flushLog();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('heartbeats land while the dispatch is pending; the pump is cleared when it settles', async () => {
    _setActivityPumpIntervalForTest(25);
    try {
      const task = await claimedTask('streaming task', 'the prompt text');
      let releaseDispatch!: () => void;
      const gate = new Promise<void>((res) => { releaseDispatch = res; });
      const capture: FyiCapture = [];
      const exec = executeTopicTask(makeArgs(task, {
        dispatch: async () => {
          await gate;
          return { worker: 'agy', result: { success: false, output: '', error: 'late boom', exitCode: 1 } };
        },
        sendFyi: makeSendFyi(capture),
      }));
      // While the dispatch is pending, the pump stamps the record (the first
      // beat is admitted; later beats ride the store's ~10s write throttle).
      for (let i = 0; i < 20 && (await listRunningTasks(CHAT_ID, THREAD_ID))[0].lastActivityAt === undefined; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const [midFlight] = await listRunningTasks(CHAT_ID, THREAD_ID);
      assert.ok(midFlight.lastActivityAt, 'a pending dispatch produces activity heartbeats');
      const heartbeatMs = Date.parse(midFlight.lastActivityAt!);
      assert.ok(Math.abs(Date.now() - heartbeatMs) < 5_000, 'the heartbeat is fresh');
      releaseDispatch();
      await exec;
      assert.equal(capture.length, 1, 'the retry FYI ran normally for the current owner');
      assert.equal(capture[0].kind, 'task-retry');
      // Leak probe: reset the store's throttle guard, then outlive the pump
      // period. A pump that outlived its attempt would stamp the (now ready)
      // record again; a cleared one leaves the last heartbeat frozen.
      _resetTopicTasksForTest();
      await new Promise((r) => setTimeout(r, 150));
      const [after] = await listRunningTasks(CHAT_ID, THREAD_ID);
      assert.ok(after, 'the deferred record survived');
      assert.equal(after.lastActivityAt, midFlight.lastActivityAt, 'no heartbeat after the dispatch settled — pump cleared');
    } finally {
      _setActivityPumpIntervalForTest(TOPIC_TASK_ACTIVITY_THROTTLE_MS);
    }
  });
});

describe('routeReplyToTask (tier-1 attribution)', () => {
  let tempDir: string;
  let originalPaHome: string | undefined;

  beforeEach(async () => {
    await flushLog();
    tempDir = await mkdtemp(join(tmpdir(), 'task-executor-route-'));
    originalPaHome = process.env.PA_HOME;
    process.env.PA_HOME = tempDir;
    _resetTopicTasksForTest();
  });

  afterEach(async () => {
    _resetTopicTasksForTest();
    await flushLog();
    if (originalPaHome === undefined) delete process.env.PA_HOME;
    else process.env.PA_HOME = originalPaHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('routeReplyToTask routes a reply-to-question-FYI on a PARKED task to ready', async () => {
    const task = await claimedTask('anchored task', 'the prompt text');
    await parkTask(CHAT_ID, THREAD_ID, task.id, { text: 'Pick one', options: ['A', 'B'] });
    await recordFyiMessage(CHAT_ID, THREAD_ID, task.id, 555);
    const replies: Array<{ text: string; replyTo: number }> = [];
    const routed = await routeReplyToTask({
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      replyToMessageId: 555,
      text: 'go with option A',
      sendReply: async (text, replyTo) => { replies.push({ text, replyTo }); },
    });
    assert.deepEqual(routed, { id: task.id, title: 'anchored task' });
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /^↩️ Sent to task: anchored task/, 'the ack text (a _Ref footer is appended)');
    assert.match(replies[0].text, /_Ref: s-[0-9a-f]{12}_/, 'the ack carries its ref-ID footer');
    assert.equal(replies[0].replyTo, 555, 'the ack replies IN-THREAD to the FYI');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.status, 'ready', 'the answer parked the record for resume');
    assert.equal(record.question, null, 'the question cleared on answer');
    assert.ok(
      record.micro_thread.some((t) => t.role === 'user' && t.text === 'go with option A'),
      'the answer landed in the task micro_thread'
    );
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    const answered = events.filter((e) => e.kind === 'question_answered' && e.ref === task.id);
    assert.equal(answered.length, 1);
    assert.equal(answered[0].detail, 'go with option A');
  });

  it('a reply to a RUNNING task feeds the micro-thread but does NOT resume it (double-dispatch guard)', async () => {
    const task = await claimedTask('in-flight task', 'the prompt text');
    await recordFyiMessage(CHAT_ID, THREAD_ID, task.id, 556);
    const replies: Array<{ text: string; replyTo: number }> = [];
    const routed = await routeReplyToTask({
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      replyToMessageId: 556,
      text: 'steer mid-flight',
      sendReply: async (text, replyTo) => { replies.push({ text, replyTo }); },
    });
    assert.deepEqual(routed, { id: task.id, title: 'in-flight task' });
    assert.equal(replies.length, 1, 'the ack still confirms delivery');
    const [record] = await listRunningTasks(CHAT_ID, THREAD_ID);
    assert.equal(record.status, 'running', 'the in-flight dispatch keeps the record — no flip to ready');
    assert.ok(
      record.micro_thread.some((t) => t.role === 'user' && t.text === 'steer mid-flight'),
      'the answer still reached the in-flight run via the micro_thread'
    );
    const events = await readTopicEvents(CHAT_ID, THREAD_ID);
    assert.equal(
      events.filter((e) => e.kind === 'question_answered' && e.ref === task.id).length,
      0,
      'no question_answered event — there was no question'
    );
  });

  it('routeReplyToTask returns null for unmatched anchor', async () => {
    await claimedTask('unrelated task', 'the prompt text');
    const replies: unknown[] = [];
    const notTask = await routeReplyToTask({
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      replyToMessageId: 424242,
      text: 'just chatting',
      sendReply: async () => { replies.push('sent'); },
    });
    assert.equal(notTask, null, 'a non-task reply falls through to normal processing');
    assert.equal(replies.length, 0, 'no ack sent for an unmatched anchor');
    const emptyText = await routeReplyToTask({
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      replyToMessageId: 424242,
      text: '',
      sendReply: async () => { replies.push('sent'); },
    });
    assert.equal(emptyText, null, 'empty text is a guard, not a route');
  });
});
