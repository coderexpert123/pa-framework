/**
 * Thread status — the ONE derivation of a voice-inbox conversation's status
 * (thread lifecycle, schema v14, 2026-09-17). Pure: no database handle and no
 * clock of its own; the caller passes `now`. summarizeConversation (ledger.ts)
 * calls it for every list, detail and router-offer row, and nothing else maps
 * a thread's tasks to a status. The PWA maps the token to a word through
 * THREAD_STATUS_TEXT, pinned to THREAD_STATUS_WORDS by sync-twins.test.ts.
 *
 * Rule: every task contributes at most one rank and the thread shows the
 * lowest rank present. The answer lifecycle (ready -> viewed -> concluded ->
 * done) follows the thread's NEWEST done task by created_at (the operator's
 * send time); older done tasks contribute nothing. An answer's landed time is
 * its task.completed event time, which never moves: a later metadata write
 * that bumps updated_at (the Telegram message id capture) must not make a
 * viewed answer Ready again. Clock-only moves (viewed -> concluded at 1 h,
 * -> done past 24 h) write nothing: every read recomputes.
 *
 * t-3 (2026-09-18): `nextActionPending` overrides that ready/viewed/concluded
 * clock with `needs_you` wherever the clock would otherwise have picked
 * ready, viewed, concluded or done — the worker's own answer (its stored
 * `conversation_meta.next_action`, written from a "NEXT ACTIONS" block's
 * first "You" step, see task_complete.py's `--next`) said the operator still
 * has to do something, so the badge must not degrade to Concluded/Done while
 * that stands. It never overrides `failed` or `running` (both a genuinely
 * live/broken state outrank a stale "you asked to double check X" note), and
 * it defaults to `false` so every pre-existing caller (and every existing
 * test) keeps today's behavior unchanged.
 */

import type { TaskState } from './ledger.js';

export const THREAD_STATUS_TOKENS = [
  'recorded',
  'transcribing',
  'routed',
  'needs_you',
  'ready',
  'failed',
  'running',
  'viewed',
  'concluded',
  'cancelled',
  'done',
] as const;

export type ThreadStatusToken = (typeof THREAD_STATUS_TOKENS)[number];

export type ThreadBand = 'live' | 'history' | 'older';

/** The word per token. The router offer renders these; the PWA's
 *  THREAD_STATUS_TEXT must equal this map byte for byte. */
export const THREAD_STATUS_WORDS: Readonly<Record<ThreadStatusToken, string>> = {
  recorded: 'Recorded',
  transcribing: 'Transcribing',
  routed: 'Routed',
  needs_you: 'Needs You',
  ready: 'Ready',
  failed: 'Failed',
  running: 'Running',
  viewed: 'Viewed',
  concluded: 'Concluded',
  cancelled: 'Cancelled',
  done: 'Done',
};

export const THREAD_STATUS_RANK: Readonly<Record<ThreadStatusToken, number>> = {
  recorded: 1,
  transcribing: 1,
  routed: 1,
  needs_you: 2,
  ready: 3,
  failed: 4,
  running: 5,
  viewed: 6,
  concluded: 7,
  cancelled: 8,
  done: 9,
};

/** Viewed lasts this long from the operator's first view of the answer. */
export const VIEWED_WINDOW_MS = 60 * 60 * 1000;
/** Concluded and Cancelled (the history band) and the router offer cover
 *  threads updated within this window; older finished threads read Done. */
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function bandForRank(rank: number): ThreadBand {
  if (rank <= 5) return 'live';
  if (rank <= 8) return 'history';
  return 'older';
}

/** The per-task inputs the rule reads. */
export interface ThreadStatusTask {
  task_id: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
  /** The retry task's id once the operator retried this failure; else null. */
  retried_by: string | null;
  /** payload.code of the task's newest task.failed event; else null. */
  failure_code: string | null;
  /** ts of the task's newest task.completed event; else null. */
  completed_at: string | null;
}

export interface ThreadStatus {
  /** null = the thread contributes nothing and is hidden. */
  status: ThreadStatusToken | null;
  status_rank: number | null;
  band: ThreadBand | null;
  /** The newest done task's completion time (its updated_at when it has no
   *  task.completed event); null when no task is done. */
  answer_landed_at: string | null;
  /** failed / transcribe_failed tasks not retried and not too_short. */
  failed_unresolved: number;
}

const PRE_RUNNING_TOKENS: ReadonlyMap<TaskState, ThreadStatusToken> = new Map<TaskState, ThreadStatusToken>([
  ['received', 'recorded'],
  ['transcribing', 'transcribing'],
  ['routed', 'routed'],
]);

/** Newest first by (created_at DESC, task_id DESC), the ledger's "newest". */
function newestFirst(a: ThreadStatusTask, b: ThreadStatusTask): number {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
  if (a.task_id === b.task_id) return 0;
  return a.task_id > b.task_id ? -1 : 1;
}

/** A failure nothing has resolved: not retried, and not a too_short
 *  recording (audio-unusable, hidden by design). */
export function isUnresolvedFailure(task: Pick<ThreadStatusTask, 'state' | 'retried_by' | 'failure_code'>): boolean {
  return (
    (task.state === 'failed' || task.state === 'transcribe_failed') &&
    task.retried_by === null &&
    task.failure_code !== 'too_short'
  );
}

export function deriveThreadStatus(
  tasks: readonly ThreadStatusTask[],
  threadViewedAt: string | null,
  pendingInputCount: number,
  now: Date,
  /** t-3 (2026-09-18): true when the thread's stored `next_action` (the
   *  worker's own "NEXT ACTIONS" You-step, task_complete.py's `--next`) is
   *  still set — the LLM's answer itself said the operator has to do
   *  something. Defaults to false so every existing caller and test keeps
   *  today's behavior unchanged. */
  nextActionPending: boolean = false
): ThreadStatus {
  const nowMs = now.getTime();
  const sorted = [...tasks].sort(newestFirst);
  let lastUpdateMs = Number.NEGATIVE_INFINITY;
  for (const t of tasks) {
    const u = Date.parse(t.updated_at);
    if (u > lastUpdateMs) lastUpdateMs = u;
  }
  const recent = nowMs - lastUpdateMs <= RECENT_WINDOW_MS;
  const newestDone = sorted.find((t) => t.state === 'done');
  const answerLandedAt = newestDone === undefined ? null : (newestDone.completed_at ?? newestDone.updated_at);
  const viewedMs = threadViewedAt === null ? Number.NaN : Date.parse(threadViewedAt);
  const viewed = answerLandedAt !== null && !Number.isNaN(viewedMs) && viewedMs >= Date.parse(answerLandedAt);
  const failedUnresolved = tasks.filter((t) => isUnresolvedFailure(t)).length;

  const candidates: ThreadStatusToken[] = [];
  const preRunning = sorted.find((t) => PRE_RUNNING_TOKENS.has(t.state));
  if (preRunning !== undefined) candidates.push(PRE_RUNNING_TOKENS.get(preRunning.state) as ThreadStatusToken);
  if (pendingInputCount > 0 || tasks.some((t) => t.state === 'awaiting_input')) candidates.push('needs_you');
  if (failedUnresolved > 0) candidates.push('failed');
  if (tasks.some((t) => t.state === 'running')) candidates.push('running');
  // t-3: the answer-landed lifecycle (ready -> viewed -> concluded -> done)
  // is overridden to needs_you at every stage while the worker's own answer
  // says the operator still has to act — it must never silently degrade to
  // Concluded/Done while that stands. Only takes over the exact branches the
  // clock would otherwise have decided (an answer must have landed). needs_you
  // (rank 2) still wins the final min-rank pick over a simultaneous `failed`
  // (4) or `running` (5) candidate — the same precedence needs_you already
  // has today from awaiting_input/pendingInputCount; this reuses that rule
  // rather than special-casing next_action's needs_you as lower-priority.
  if (answerLandedAt !== null && !viewed) candidates.push(nextActionPending ? 'needs_you' : 'ready');
  if (answerLandedAt !== null && viewed) {
    if (nextActionPending) candidates.push('needs_you');
    else if (nowMs - viewedMs < VIEWED_WINDOW_MS) candidates.push('viewed');
    else candidates.push(recent ? 'concluded' : 'done');
  }
  if (tasks.some((t) => t.state === 'cancelled')) candidates.push(recent ? 'cancelled' : 'done');

  if (candidates.length === 0) {
    return { status: null, status_rank: null, band: null, answer_landed_at: answerLandedAt, failed_unresolved: failedUnresolved };
  }
  let best = candidates[0];
  for (const c of candidates) {
    if (THREAD_STATUS_RANK[c] < THREAD_STATUS_RANK[best]) best = c;
  }
  const rank = THREAD_STATUS_RANK[best];
  return { status: best, status_rank: rank, band: bandForRank(rank), answer_landed_at: answerLandedAt, failed_unresolved: failedUnresolved };
}
