/**
 * Voice-inbox Telegram message_id capture tests (AI-218).
 *
 * Every test injects deps {pythonCmd, scriptPath, spawnFn} — no real python,
 * no real ledger. The fake spawn returns a controllable child stub (the same
 * shape voice-input-mirror.test.ts uses); tests drive its stdout/close events
 * and assert the EXACT argv the capture built.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  captureTaskMessageIds,
  voiceMessageIdScriptPath,
} from '../voice-message-id-capture.js';
import type { MirrorChild, MirrorDeps, MirrorSpawnFn } from '../voice-input-mirror.js';

const SCRIPT = 'C:/fake/task_set_message_id.py';
const TASK_A = 'vi-1234567890ab'; // synthetic fixture id family, never a real task
const TASK_B = 'vi-abcdef123456';

interface CapturedSpawn {
  cmd: string;
  args: string[];
  opts: { windowsHide: boolean; stdio: ['ignore', 'pipe', 'pipe']; shell: false };
}

/** A controllable child stub: tests emit stdout/stderr/close/error manually. */
function makeChild() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let killed = false;
  const child: MirrorChild = {
    stdout: { on: (ev, cb) => listeners.set(`stdout:${ev}`, cb as (...args: unknown[]) => void) },
    stderr: { on: (ev, cb) => listeners.set(`stderr:${ev}`, cb as (...args: unknown[]) => void) },
    on: (ev, cb) => listeners.set(ev, cb as (...args: unknown[]) => void),
    kill: () => {
      killed = true;
    },
  };
  return {
    child,
    killed: () => killed,
    stdout: (text: string) => listeners.get('stdout:data')?.(text),
    stderr: (text: string) => listeners.get('stderr:data')?.(text),
    close: (code: number | null = 0) => listeners.get('close')?.(code),
  };
}

/**
 * A spawnFn that hands out a FRESH child per spawn and records each one in
 * order — multi-spawn tests drive the children sequentially without listener
 * collisions (each child owns its own listener map).
 */
function makeQueueDeps(): { deps: MirrorDeps; spawns: CapturedSpawn[]; children: ReturnType<typeof makeChild>[] } {
  const spawns: CapturedSpawn[] = [];
  const children: ReturnType<typeof makeChild>[] = [];
  const spawnFn: MirrorSpawnFn = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    const c = makeChild();
    children.push(c);
    return c.child;
  };
  return { deps: { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn }, spawns, children };
}

/** Drive the nth queued child to a successful JSON close. */
async function succeedNth(children: ReturnType<typeof makeChild>[], n: number, json: string): Promise<void> {
  await Promise.resolve(); // let the loop advance and register the nth spawn
  children[n].stdout(json);
  children[n].close(0);
}

describe('captureTaskMessageIds', () => {
  it('spawns one --task/--message-id call per task id with the exact argv', async () => {
    const { deps, spawns, children } = makeQueueDeps();
    const done = captureTaskMessageIds([TASK_A, TASK_B], 4242, deps);
    await succeedNth(children, 0, `{"ok":true,"task_id":"${TASK_A}","tg_message_id":4242}`);
    await succeedNth(children, 1, `{"ok":true,"task_id":"${TASK_B}","tg_message_id":4242}`);
    const results = await done;

    assert.equal(spawns.length, 2);
    assert.equal(spawns[0].cmd, 'py');
    assert.deepEqual(spawns[0].args, [SCRIPT, '--task', TASK_A, '--message-id', '4242']);
    assert.deepEqual(spawns[1].args, [SCRIPT, '--task', TASK_B, '--message-id', '4242']);
    assert.deepEqual(spawns[0].opts, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    assert.deepEqual(results, [
      { taskId: TASK_A, ok: true },
      { taskId: TASK_B, ok: true },
    ]);
  });

  it('a single task succeeds and resolves {ok:true}', async () => {
    const { deps, children } = makeQueueDeps();
    const done = captureTaskMessageIds([TASK_A], 7, deps);
    await succeedNth(children, 0, '{"ok":true,"task_id":"vi-1234567890ab","tg_message_id":7}');
    const results = await done;
    assert.deepEqual(results, [{ taskId: TASK_A, ok: true }]);
  });

  it('surfaces a failure JSON line as {ok:false} with the error text and never throws', async () => {
    const { deps, children } = makeQueueDeps();
    const done = captureTaskMessageIds([TASK_A], 1, deps);
    await succeedNth(children, 0, `{"ok":false,"error":"task not found: ${TASK_A}"}`);
    const results = await done;
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].taskId, TASK_A);
    assert.ok(results[0].error?.includes('task not found'));
  });

  it('a nonzero exit surfaces the stderr tail, not a fake success', async () => {
    const { deps, children } = makeQueueDeps();
    const done = captureTaskMessageIds([TASK_A], 1, deps);
    await Promise.resolve();
    children[0].stderr('ledger missing: start the server first');
    children[0].close(1);
    const results = await done;
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error?.includes('exited 1'));
    assert.ok(results[0].error?.includes('ledger missing'));
  });

  it('a null exit code (killed by signal) is a failure naming the script', async () => {
    const { deps, children } = makeQueueDeps();
    const done = captureTaskMessageIds([TASK_A], 1, deps);
    await Promise.resolve();
    children[0].close(null);
    const results = await done;
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error?.includes('task_set_message_id.py'));
  });

  it('the timeout kills the child and resolves {ok:false, error:"timeout"}', async () => {
    const c = makeChild();
    const done = captureTaskMessageIds(
      [TASK_A],
      1,
      { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn: () => c.child, timeoutMs: 50 },
    );
    // No stdout, no close — the child hangs until the timeout fires.
    const results = await done;
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, 'timeout');
    assert.ok(c.killed(), 'the hung child is killed');
  });

  it('a throwing spawnFn resolves {ok:false} with the message, never throwing', async () => {
    const results = await captureTaskMessageIds(
      [TASK_A],
      1,
      { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn: () => { throw new Error('spawn blew up'); } },
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error?.includes('spawn blew up'));
  });

  it('an empty task list or a null/non-integer messageId is a no-op (empty array, no spawn)', async () => {
    const { deps, spawns } = makeQueueDeps();
    const r1 = await captureTaskMessageIds([], 4242, deps);
    const r2 = await captureTaskMessageIds([TASK_A], null, deps);
    const r3 = await captureTaskMessageIds([TASK_A], 1.5, deps);
    assert.deepEqual(r1, []);
    assert.deepEqual(r2, []);
    assert.deepEqual(r3, []);
    assert.equal(spawns.length, 0, 'no spawn fires on a no-op input');
  });

  it('resolves the script path in production shape (no scriptPath dep)', async () => {
    // Repo root: tests -> dist -> telegram-bot -> projects -> repo root (5 dirname hops).
    const repoRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
    const expectedScript = join(repoRoot, 'projects', 'voice-inbox', 'scripts', 'task_set_message_id.py');
    assert.equal(voiceMessageIdScriptPath(), expectedScript);
  });

  it('a partial batch failure does not abort the survivors', async () => {
    const { deps, spawns, children } = makeQueueDeps();
    const done = captureTaskMessageIds([TASK_A, TASK_B], 9, deps);
    // First task fails (unknown task), second succeeds.
    await succeedNth(children, 0, `{"ok":false,"error":"task not found: ${TASK_A}"}`);
    await succeedNth(children, 1, `{"ok":true,"task_id":"${TASK_B}","tg_message_id":9}`);
    const results = await done;
    assert.equal(spawns.length, 2);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].taskId, TASK_A);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].taskId, TASK_B);
  });
});
