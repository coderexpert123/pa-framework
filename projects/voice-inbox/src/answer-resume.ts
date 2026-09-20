/**
 * Answer-and-resume core (AI-220 auth broker Phase A, C2/C6 of the build
 * spec): the ONE place that records an answer to an input request AND
 * resumes the worker waiting on it. Before this module, `answerHandler`
 * (routes.ts) wrote the answer straight through `answerInputRequest` with no
 * resume signal — the AI-221 bug. Every caller that resolves an input
 * request (the JSON answer handler, `pollOauthResolutions`, the auth
 * callback, and `pa auth answer`) must call `answerAndResume` instead of
 * `answerInputRequest` directly, or the bug reappears on that path.
 *
 * The resume signal is a `kind:"steer"` route-queue entry (no new key, no
 * new verb — C8): it fires only when the task has somewhere to steer (D4) —
 * a parseable `routed_to` topic AND a non-empty `worker_resource`. A standing
 * auth task (no dispatch, no worker_resource) queues nothing; `pa auth wait`
 * is its consumer instead.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { answerInputRequest, type InputRequestRow, type TaskRow } from './ledger.js';
import { appendRouteEntry, buildAnswerPointerText } from './bridge-writer.js';
import { splitTopicKey } from './config.js';

/** The value either arrived inline (a JSON/text answer) or already lives at
 * a pointer path (a file upload, or a non-secret oauth completion marker). */
export type AnswerInput = { kind: 'value'; value: string } | { kind: 'pointer'; pointer: string };

export interface AnswerResumeDeps {
  routeQueuePath: string;
  answersDir: string;
  /** Optional structural dep (AI-246 v2 WP-J): when it reports the operator
   *  has driven the live page, the steer text warns the resuming worker to
   *  re-check real page state before acting on the blocker it asked about. */
  inputStore?: { lastInputAt(taskId: string): number | null };
}

export interface AnswerResumeResult {
  request: InputRequestRow;
  task: TaskRow;
  steer_queued: boolean;
  steer_skipped_reason?: 'no-routed-to' | 'no-worker-resource' | 'append-failed';
}

/**
 * Answer an input request and, when the task has a live worker to resume,
 * queue exactly one steer route-queue entry carrying the answer pointer
 * (§3.6 of the build spec). Never throws on the steer append — a failure
 * there degrades to `steer_skipped_reason: 'append-failed'` because the
 * answer itself must still land even if the resume signal cannot.
 */
export async function answerAndResume(
  db: Database.Database,
  tenantId: string,
  taskId: string,
  requestId: string,
  answer: AnswerInput,
  deps: AnswerResumeDeps
): Promise<AnswerResumeResult> {
  let answerPointer: string;
  if (answer.kind === 'value') {
    const dir = join(deps.answersDir, taskId);
    mkdirSync(dir, { recursive: true });
    answerPointer = join(dir, `${requestId}.txt`);
    // The value lives ONLY here; the ledger stores the pointer (§4).
    writeFileSync(answerPointer, answer.value, { encoding: 'utf8', mode: 0o600 });
  } else {
    answerPointer = answer.pointer;
  }

  const { request, task } = answerInputRequest(db, tenantId, taskId, requestId, { answerPointer });

  let steer_queued = false;
  let steer_skipped_reason: AnswerResumeResult['steer_skipped_reason'];

  const topic = task.routed_to ? splitTopicKey(task.routed_to) : undefined;
  if (!topic) {
    steer_skipped_reason = 'no-routed-to';
  } else if (!task.worker_resource) {
    steer_skipped_reason = 'no-worker-resource';
  } else {
    try {
      const operatorInputAt = deps.inputStore?.lastInputAt(taskId);
      const takeoverNote =
        operatorInputAt !== null && operatorInputAt !== undefined
          ? ` The operator took over the live page at ${new Date(operatorInputAt).toISOString()} — re-check the actual page state before continuing; they may have already acted on the blocker.`
          : '';
      await appendRouteEntry(deps.routeQueuePath, {
        taskId: task.task_id,
        tenantId: task.tenant_id,
        chatId: topic.chatId,
        threadId: topic.threadId,
        text:
          `[Voice inbox task ${task.task_id}] ` +
          `${buildAnswerPointerText({ requestId, answerPointer })} ` +
          `Continue the task from where it paused, then finish with task_complete.py.` +
          takeoverNote,
        kind: 'steer',
        steerMode: 'queue',
        steerConversation: task.conversation_id,
      });
      steer_queued = true;
    } catch {
      steer_skipped_reason = 'append-failed';
    }
  }

  return { request, task, steer_queued, steer_skipped_reason };
}
