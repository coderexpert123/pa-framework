/**
 * answerAndResume tests (AI-220 auth broker Phase A, WP-A): the C2 fix — every
 * caller that answers an input request must also resume the worker waiting
 * on it via exactly one `kind:"steer"` route-queue entry, gated by D4 (a
 * parseable `routed_to` topic AND a non-empty `worker_resource`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerAndResume } from '../answer-resume.js';
import {
  createInputRequest,
  createTask,
  getInputRequest,
  openLedger,
  transitionTask,
  upsertTenant,
} from '../ledger.js';

interface Fixture {
  dir: string;
  db: ReturnType<typeof openLedger>;
  tenantId: string;
  routeQueuePath: string;
  answersDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'voice-inbox-answer-resume-'));
  const db = openLedger(join(dir, 'ledger.sqlite'));
  const tenant = upsertTenant(db, { telegramUserId: 42, telegramChatId: -1001234567890, displayName: 'Op' });
  return {
    dir,
    db,
    tenantId: tenant.tenant_id,
    routeQueuePath: join(dir, 'route-queue.jsonl'),
    answersDir: join(dir, 'answers'),
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

/** Move a task received -> routed -> running and open a secret input request. */
function makeRunningTaskWithRequest(fx: Fixture): { taskId: string; requestId: string } {
  const task = createTask(fx.db, fx.tenantId, { source: 'text', requestText: 'renew the cert' });
  transitionTask(fx.db, fx.tenantId, task.task_id, 'routed', {
    eventKind: 'task.routed',
    routedTo: '-1001234567890_2002',
    routingReason: 'test',
  });
  transitionTask(fx.db, fx.tenantId, task.task_id, 'running', {
    eventKind: 'task.progress',
    eventPayload: { step: 'starting' },
  });
  const created = createInputRequest(fx.db, fx.tenantId, task.task_id, {
    kind: 'secret',
    prompt: 'API key?',
    params: {},
  });
  return { taskId: task.task_id, requestId: created.request.request_id };
}

function setWorkerResource(fx: Fixture, taskId: string, resource: string | null): void {
  fx.db.prepare('UPDATE tasks SET worker_resource = ? WHERE task_id = ?').run(resource, taskId);
}

function readQueueLines(routeQueuePath: string): Record<string, unknown>[] {
  try {
    const raw = readFileSync(routeQueuePath, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('answerAndResume — writes 0600, answers, and queues one steer', () => {
  it('value path writes the answer file and answers the request', async () => {
    const fx = makeFixture();
    try {
      const { taskId, requestId } = makeRunningTaskWithRequest(fx);
      const result = await answerAndResume(
        fx.db,
        fx.tenantId,
        taskId,
        requestId,
        { kind: 'value', value: 'sk-secret-value' },
        { routeQueuePath: fx.routeQueuePath, answersDir: fx.answersDir }
      );
      assert.equal(result.request.status, 'answered');
      assert.ok(result.request.answer_pointer, 'answer_pointer must be set');
      const pointer = result.request.answer_pointer as string;
      assert.equal(readFileSync(pointer, 'utf8'), 'sk-secret-value');
      if (process.platform !== 'win32') {
        const mode = statSync(pointer).mode & 0o777;
        assert.equal(mode, 0o600);
      }
      assert.equal(result.task.state, 'running');
    } finally {
      fx.cleanup();
    }
  });

  it('a task with routed_to and worker_resource queues exactly one steer line matching §3.6', async () => {
    const fx = makeFixture();
    try {
      const { taskId, requestId } = makeRunningTaskWithRequest(fx);
      setWorkerResource(fx, taskId, 'topic--1001234567890_2002');
      const result = await answerAndResume(
        fx.db,
        fx.tenantId,
        taskId,
        requestId,
        { kind: 'value', value: 'sk-secret-value' },
        { routeQueuePath: fx.routeQueuePath, answersDir: fx.answersDir }
      );
      assert.equal(result.steer_queued, true);
      assert.equal(result.steer_skipped_reason, undefined);

      const lines = readQueueLines(fx.routeQueuePath);
      assert.equal(lines.length, 1);
      const entry = lines[0];
      assert.deepEqual(Object.keys(entry), [
        'q_id', 'ts', 'task_id', 'tenant_id', 'chat_id', 'thread_id', 'text', 'ref_id',
        'kind', 'steer_mode', 'steer_conversation',
      ]);
      assert.equal(entry.task_id, taskId);
      assert.equal(entry.tenant_id, fx.tenantId);
      assert.equal(entry.chat_id, -1001234567890);
      assert.equal(entry.thread_id, 2002);
      assert.equal(entry.kind, 'steer');
      assert.equal(entry.steer_mode, 'queue');
      assert.equal(entry.steer_conversation, result.task.conversation_id);
      const pointer = result.request.answer_pointer as string;
      assert.equal(
        entry.text,
        `[Voice inbox task ${taskId}] Answer for ${requestId} is at ${pointer}` +
          ' — read it; never repeat its value in chat. Continue the task from where it paused, ' +
          'then finish with task_complete.py.'
      );
    } finally {
      fx.cleanup();
    }
  });

  it('an empty worker_resource skips the steer with zero queue lines', async () => {
    const fx = makeFixture();
    try {
      const { taskId, requestId } = makeRunningTaskWithRequest(fx);
      // worker_resource defaults to NULL — never set here.
      const result = await answerAndResume(
        fx.db,
        fx.tenantId,
        taskId,
        requestId,
        { kind: 'value', value: 'sk-secret-value' },
        { routeQueuePath: fx.routeQueuePath, answersDir: fx.answersDir }
      );
      assert.equal(result.steer_queued, false);
      assert.equal(result.steer_skipped_reason, 'no-worker-resource');
      assert.equal(readQueueLines(fx.routeQueuePath).length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('routed_to null skips the steer with zero queue lines', async () => {
    const fx = makeFixture();
    try {
      // A task that reached running without ever recording a routed_to (the
      // ledger-level shape this guard checks for — createInputRequest only
      // accepts a task in 'running', reached here via 'routed' with no
      // routedTo supplied, so routed_to stays NULL throughout).
      const task = createTask(fx.db, fx.tenantId, { source: 'text', requestText: 'authorize google' });
      transitionTask(fx.db, fx.tenantId, task.task_id, 'routed', { eventKind: 'task.routed' });
      transitionTask(fx.db, fx.tenantId, task.task_id, 'running', { eventKind: 'task.progress' });
      const created = createInputRequest(fx.db, fx.tenantId, task.task_id, {
        kind: 'oauth',
        prompt: 'Grant Google access',
        params: { provider: 'google' },
      });
      assert.equal(created.task.routed_to, null);
      const result = await answerAndResume(
        fx.db,
        fx.tenantId,
        task.task_id,
        created.request.request_id,
        { kind: 'pointer', pointer: join(fx.answersDir, task.task_id, 'marker.txt') },
        { routeQueuePath: fx.routeQueuePath, answersDir: fx.answersDir }
      );
      assert.equal(result.steer_queued, false);
      assert.equal(result.steer_skipped_reason, 'no-routed-to');
      assert.equal(readQueueLines(fx.routeQueuePath).length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('an appendRouteEntry failure sets append-failed and still leaves the request answered', async () => {
    const fx = makeFixture();
    try {
      const { taskId, requestId } = makeRunningTaskWithRequest(fx);
      setWorkerResource(fx, taskId, 'topic--1001234567890_2002');
      // Force appendRouteEntry to throw: its ensureQueueFile does a recursive
      // mkdir on dirname(routeQueuePath); pre-creating that path AS A FILE
      // makes the recursive mkdir fail with ENOTDIR.
      const blocker = join(fx.dir, 'blocker');
      writeFileSync(blocker, 'not a directory', 'utf8');
      const brokenQueuePath = join(blocker, 'route-queue.jsonl');

      const result = await answerAndResume(
        fx.db,
        fx.tenantId,
        taskId,
        requestId,
        { kind: 'value', value: 'sk-secret-value' },
        { routeQueuePath: brokenQueuePath, answersDir: fx.answersDir }
      );
      assert.equal(result.steer_queued, false);
      assert.equal(result.steer_skipped_reason, 'append-failed');
      assert.equal(result.request.status, 'answered');
      const requestRow = getInputRequest(fx.db, fx.tenantId, taskId, requestId);
      assert.equal(requestRow?.status, 'answered');
    } finally {
      fx.cleanup();
    }
  });

  it('appends the operator-takeover line when inputStore reports a timestamp (WP-J)', async () => {
    const fx = makeFixture();
    try {
      const { taskId, requestId } = makeRunningTaskWithRequest(fx);
      setWorkerResource(fx, taskId, 'topic--1001234567890_2002');
      const inputAt = 1_700_000_000_000;
      const result = await answerAndResume(
        fx.db,
        fx.tenantId,
        taskId,
        requestId,
        { kind: 'value', value: 'sk-secret-value' },
        {
          routeQueuePath: fx.routeQueuePath,
          answersDir: fx.answersDir,
          inputStore: { lastInputAt: () => inputAt },
        }
      );
      assert.equal(result.steer_queued, true);
      const lines = readQueueLines(fx.routeQueuePath);
      assert.equal(lines.length, 1);
      const entry = lines[0];
      const pointer = result.request.answer_pointer as string;
      assert.equal(
        entry.text,
        `[Voice inbox task ${taskId}] Answer for ${requestId} is at ${pointer}` +
          ' — read it; never repeat its value in chat. Continue the task from where it paused, ' +
          'then finish with task_complete.py.' +
          ` The operator took over the live page at ${new Date(inputAt).toISOString()} — re-check the actual page state before continuing; they may have already acted on the blocker.`
      );
    } finally {
      fx.cleanup();
    }
  });

  it('leaves the steer text unchanged when the inputStore dep is absent or reports null', async () => {
    for (const inputStore of [undefined, { lastInputAt: () => null }]) {
      const fx = makeFixture();
      try {
        const { taskId, requestId } = makeRunningTaskWithRequest(fx);
        setWorkerResource(fx, taskId, 'topic--1001234567890_2002');
        const deps =
          inputStore === undefined
            ? { routeQueuePath: fx.routeQueuePath, answersDir: fx.answersDir }
            : { routeQueuePath: fx.routeQueuePath, answersDir: fx.answersDir, inputStore };
        const result = await answerAndResume(
          fx.db,
          fx.tenantId,
          taskId,
          requestId,
          { kind: 'value', value: 'sk-secret-value' },
          deps
        );
        assert.equal(result.steer_queued, true);
        const lines = readQueueLines(fx.routeQueuePath);
        assert.equal(lines.length, 1);
        const entry = lines[0];
        const pointer = result.request.answer_pointer as string;
        assert.equal(
          entry.text,
          `[Voice inbox task ${taskId}] Answer for ${requestId} is at ${pointer}` +
            ' — read it; never repeat its value in chat. Continue the task from where it paused, ' +
            'then finish with task_complete.py.'
        );
      } finally {
        fx.cleanup();
      }
    }
  });
});
