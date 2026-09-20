/**
 * Thread status derivation (thread lifecycle, schema v14, 2026-09-17): the ONE
 * rule that turns a thread's tasks, its server-recorded view time, its pending
 * ask count and the clock into a status token, rank and band.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandForRank,
  deriveThreadStatus,
  THREAD_STATUS_RANK,
  THREAD_STATUS_TOKENS,
  THREAD_STATUS_WORDS,
  type ThreadStatusTask,
} from '../thread-status.js';
import type { TaskState } from '../ledger.js';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const at = (hhmm: string, day = '2026-09-17'): string => `${day}T${hhmm}:00.000Z`;

function task(id: string, state: TaskState, created: string, extra: Partial<ThreadStatusTask> = {}): ThreadStatusTask {
  return {
    task_id: id,
    state,
    created_at: created,
    updated_at: created,
    retried_by: null,
    failure_code: null,
    completed_at: null,
    ...extra,
  };
}

describe('deriveThreadStatus (v14)', () => {
  it('a pre-running task outranks everything and the newest one names the stage', () => {
    const answered = task('t1', 'done', at('09:00'), { completed_at: at('09:30') });
    const routed = task('t2', 'routed', at('10:00'));
    const s = deriveThreadStatus([answered, routed], null, 0, NOW);
    assert.equal(s.status, 'routed');
    assert.equal(s.status_rank, 1);
    assert.equal(s.band, 'live');
    assert.equal(deriveThreadStatus([task('t3', 'received', at('11:00'))], null, 0, NOW).status, 'recorded');
    const newer = task('t4', 'transcribing', at('11:30'));
    assert.equal(deriveThreadStatus([routed, newer], null, 1, NOW).status, 'transcribing');
  });

  it('needs_you comes from an asking task or from a pending ask count', () => {
    assert.equal(deriveThreadStatus([task('t1', 'awaiting_input', at('10:00'))], null, 0, NOW).status, 'needs_you');
    const answered = task('t2', 'done', at('10:00'), { completed_at: at('10:10') });
    const s = deriveThreadStatus([answered], null, 1, NOW);
    assert.equal(s.status, 'needs_you');
    assert.equal(s.status_rank, 2);
  });

  it('t-3: nextActionPending overrides ready/viewed/concluded/done with needs_you, but never failed/running', () => {
    const answered = task('t1', 'done', at('09:00'), { completed_at: at('09:30') });
    const unviewed = deriveThreadStatus([answered], null, 0, NOW, true);
    assert.equal(unviewed.status, 'needs_you');
    assert.equal(unviewed.status_rank, 2);
    const viewedRecently = deriveThreadStatus([answered], at('09:35'), 0, NOW, true);
    assert.equal(viewedRecently.status, 'needs_you', 'would otherwise be viewed');
    const nextDay = new Date('2026-09-18T11:01:00.000Z');
    const wouldBeDone = deriveThreadStatus([answered], at('09:35'), 0, nextDay, true);
    assert.equal(wouldBeDone.status, 'needs_you', 'would otherwise have degraded to concluded/done');
    // false (the default) reproduces today's unmodified behavior exactly.
    assert.equal(deriveThreadStatus([answered], null, 0, NOW).status, 'ready');
    assert.equal(deriveThreadStatus([answered], null, 0, NOW, false).status, 'ready');
    // needs_you (rank 2) still wins the final pick over a simultaneous failed
    // (4) or running (5) candidate — the same precedence needs_you already
    // has today from awaiting_input/pendingInputCount (see the 'needs_you
    // comes from an asking task' test above); next_action's needs_you is not
    // special-cased to a lower priority.
    const failed = task('t2', 'failed', at('09:40'));
    assert.equal(deriveThreadStatus([answered, failed], null, 0, NOW, true).status, 'needs_you');
    const running = task('t3', 'running', at('09:40'));
    assert.equal(deriveThreadStatus([answered, running], null, 0, NOW, true).status, 'needs_you');
  });

  it('ready holds while the newest answer is unviewed, at any age', () => {
    const old = task('t1', 'done', at('08:00', '2026-09-10'), { completed_at: at('08:05', '2026-09-10') });
    const s = deriveThreadStatus([old], null, 0, NOW);
    assert.equal(s.status, 'ready');
    assert.equal(s.band, 'live');
    assert.equal(s.answer_landed_at, at('08:05', '2026-09-10'));
    assert.equal(
      deriveThreadStatus([old], at('08:00', '2026-09-10'), 0, NOW).status,
      'ready',
      'a view before the answer landed does not count'
    );
  });

  it('viewed lasts one hour from the view, then concluded within 24 hours, then done', () => {
    const answered = task('t1', 'done', at('10:00'), { completed_at: at('11:00'), updated_at: at('11:00') });
    const viewed = deriveThreadStatus([answered], at('11:15'), 0, NOW);
    assert.equal(viewed.status, 'viewed');
    assert.equal(viewed.band, 'history');
    assert.equal(
      deriveThreadStatus([answered], at('11:00'), 0, NOW).status,
      'concluded',
      'the Viewed hour is over at exactly one hour'
    );
    const nextDay = new Date('2026-09-18T11:01:00.000Z');
    const done = deriveThreadStatus([answered], at('11:15'), 0, nextDay);
    assert.equal(done.status, 'done');
    assert.equal(done.band, 'older');
    assert.equal(done.status_rank, 9);
  });

  it('only the newest done task drives the answer lifecycle', () => {
    const first = task('t1', 'done', at('09:00'), { completed_at: at('09:05') });
    const second = task('t2', 'done', at('10:00'), { completed_at: at('10:30') });
    assert.equal(deriveThreadStatus([first, second], at('10:10'), 0, NOW).status, 'ready');
    assert.equal(deriveThreadStatus([first, second], at('11:30'), 0, NOW).status, 'viewed');
  });

  it('failed counts unresolved failures only: never too_short, never a retried failure', () => {
    const failed = task('t1', 'failed', at('10:00'));
    const s = deriveThreadStatus([failed], null, 0, NOW);
    assert.equal(s.status, 'failed');
    assert.equal(s.status_rank, 4);
    assert.equal(s.failed_unresolved, 1);
    const retried = task('t1', 'failed', at('10:00'), { retried_by: 't2' });
    const retry = task('t2', 'received', at('10:05'));
    const r = deriveThreadStatus([retried, retry], null, 0, NOW);
    assert.equal(r.status, 'recorded');
    assert.equal(r.failed_unresolved, 0);
    const tooShort = task('t3', 'transcribe_failed', at('10:00'), { failure_code: 'too_short' });
    const hidden = deriveThreadStatus([tooShort], null, 0, NOW);
    assert.equal(hidden.status, null);
    assert.equal(hidden.band, null);
    assert.equal(hidden.failed_unresolved, 0);
    const infra = task('t4', 'transcribe_failed', at('10:00'), { failure_code: 'infra' });
    assert.equal(deriveThreadStatus([infra], null, 0, NOW).status, 'failed');
  });

  it('failed outranks running and running outranks the history band', () => {
    const failed = task('t1', 'failed', at('09:00'));
    const running = task('t2', 'running', at('10:00'));
    assert.equal(deriveThreadStatus([failed, running], null, 0, NOW).status, 'failed');
    const answered = task('t3', 'done', at('08:00'), { completed_at: at('08:30') });
    assert.equal(deriveThreadStatus([answered, running], at('11:50'), 0, NOW).status, 'running');
  });

  it('cancelled shows within 24 hours, then reads done', () => {
    const recent = task('t1', 'cancelled', at('09:00'), { updated_at: at('11:00') });
    const s = deriveThreadStatus([recent], null, 0, NOW);
    assert.equal(s.status, 'cancelled');
    assert.equal(s.band, 'history');
    const old = task('t2', 'cancelled', at('09:00', '2026-09-15'));
    const o = deriveThreadStatus([old], null, 0, NOW);
    assert.equal(o.status, 'done');
    assert.equal(o.band, 'older');
  });

  it('answer_landed_at is the completion event time, never a later updated_at', () => {
    const answered = task('t1', 'done', at('09:00'), { completed_at: at('10:00'), updated_at: at('11:50') });
    const s = deriveThreadStatus([answered], at('11:30'), 0, NOW);
    assert.equal(s.answer_landed_at, at('10:00'));
    assert.equal(s.status, 'viewed', 'a metadata write after the view must not make the answer Ready again');
    const legacy = task('t2', 'done', at('09:00'), { updated_at: at('09:10') });
    assert.equal(
      deriveThreadStatus([legacy], null, 0, NOW).answer_landed_at,
      at('09:10'),
      'no completion event: updated_at is the fallback'
    );
  });

  it('the vocabulary: every token has a word, ranks follow token order, bands split at 5 and 8', () => {
    assert.deepEqual(Object.keys(THREAD_STATUS_WORDS), [...THREAD_STATUS_TOKENS]);
    assert.deepEqual(Object.keys(THREAD_STATUS_RANK), [...THREAD_STATUS_TOKENS]);
    assert.deepEqual(THREAD_STATUS_TOKENS.map((t) => THREAD_STATUS_RANK[t]), [1, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(THREAD_STATUS_WORDS.needs_you, 'Needs You');
    assert.deepEqual([1, 5, 6, 8, 9].map(bandForRank), ['live', 'live', 'history', 'history', 'older']);
  });

  it('a thread with no contributing task is hidden', () => {
    assert.deepEqual(deriveThreadStatus([], null, 0, NOW), {
      status: null,
      status_rank: null,
      band: null,
      answer_landed_at: null,
      failed_unresolved: 0,
    });
  });
});
