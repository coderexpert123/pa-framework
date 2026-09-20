/**
 * Voice-input mirror tests (button parity, 2026-09-11).
 *
 * Every test injects deps {pythonCmd, scriptPath, spawnFn} — no real python,
 * no real ledger. The fake spawn returns a controllable child stub; tests
 * drive its stdout/close events and assert the EXACT argv the mirror built.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'path';
import {
  cancelMirroredAsk,
  capPromptForWidget,
  mirrorAskAsWidget,
  type MirrorChild,
  type MirrorDeps,
  type MirrorSpawnFn,
} from '../voice-input-mirror.js';

const SCRIPT = 'C:/fake/task_input.py';
const TASK_ID = 'vi-1234567890ab'; // synthetic fixture id family, never a real task

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
    emit: (ev: string, ...args: unknown[]) => listeners.get(ev)?.(...args),
    stdout: (text: string) => listeners.get('stdout:data')?.(text),
    stderr: (text: string) => listeners.get('stderr:data')?.(text),
    close: (code: number | null = 0) => listeners.get('close')?.(code),
  };
}

/** Capture argv and return the child handle so the test drives the lifecycle. */
function makeDeps(child: ReturnType<typeof makeChild>): { deps: MirrorDeps; spawns: CapturedSpawn[] } {
  const spawns: CapturedSpawn[] = [];
  const spawnFn: MirrorSpawnFn = (cmd, args, opts) => {
    spawns.push({ cmd, args, opts });
    return child.child;
  };
  return { deps: { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn }, spawns };
}

describe('capPromptForWidget', () => {
  it('passes short text through untouched', () => {
    assert.equal(capPromptForWidget('Which plan do you want?'), 'Which plan do you want?');
  });

  it('strips one trailing confirm sentence, with or without the * emphasis markers', () => {
    assert.equal(capPromptForWidget('Delete the stray branch? Reply *yes* to confirm or *no* to cancel.'), 'Delete the stray branch?');
    assert.equal(capPromptForWidget('Delete the stray branch? Reply yes to confirm or no to cancel.'), 'Delete the stray branch?');
    assert.equal(capPromptForWidget('Deploy now? Reply *YES* to confirm or *NO* to cancel.'), 'Deploy now?');
    // A sentence in the MIDDLE is content, not the confirm gesture.
    assert.ok(capPromptForWidget('Reply yes to confirm or no to cancel. Then wait.').includes('confirm'));
  });

  it('clamps to 500 chars with a single ellipsis when cut', () => {
    const exact = 'a'.repeat(500);
    assert.equal(capPromptForWidget(exact), exact); // at the cap: untouched
    const cut = capPromptForWidget('b'.repeat(501));
    assert.equal(cut.length, 500);
    assert.ok(cut.endsWith('…'));
    assert.equal(cut.slice(0, 499), 'b'.repeat(499));
    // The clamp applies AFTER the sentence strip.
    const stripped = capPromptForWidget(`${'c'.repeat(500)} Reply *yes* to confirm or *no* to cancel.`);
    assert.equal(stripped.length, 500);
    assert.ok(!stripped.includes('cancel'));
  });
});

describe('mirrorAskAsWidget', () => {
  it('spawns create with the exact argv for a choice ask, incl. the --param options=<json> form', async () => {
    const c = makeChild();
    const { deps, spawns } = makeDeps(c);
    const done = mirrorAskAsWidget({
      taskIds: [TASK_ID],
      kind: 'choice',
      prompt: 'Which plan?',
      options: ['Plan A', 'Plan B'],
      summary: 'plan choice',
    }, deps);
    c.stdout('\n');
    c.stdout(`\n{"ok":true,"task_id":"${TASK_ID}","request_id":"ir-abc123def456","kind":"choice"}\n`);
    c.close(0);
    const result = await done;

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].cmd, 'py');
    assert.deepEqual(spawns[0].args, [
      SCRIPT, 'create', '--task', TASK_ID, '--kind', 'choice', '--prompt', 'Which plan?',
      '--param', 'options=["Plan A","Plan B"]',
      '--summary', 'plan choice',
    ]);
    assert.deepEqual(spawns[0].opts, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    assert.deepEqual(result, { ok: true, taskId: TASK_ID, requestId: 'ir-abc123def456' });
  });

  it('omits --param for a confirm ask and clamps the prompt via capPromptForWidget', async () => {
    const c = makeChild();
    const { deps, spawns } = makeDeps(c);
    const done = mirrorAskAsWidget({
      taskIds: [TASK_ID],
      kind: 'confirm',
      prompt: `Deploy the fix? ${'x'.repeat(600)} Reply *yes* to confirm or *no* to cancel.`,
    }, deps);
    c.stdout('{"ok":true,"task_id":"vi-1234567890ab","request_id":"ir-000000000000"}');
    c.close(0);
    await done;

    const args = spawns[0].args;
    assert.equal(args[1], 'create');
    assert.ok(!args.includes('--param'), 'confirm carries no options param');
    assert.ok(!args.includes('--summary'), 'summary omitted when not given');
    const prompt = args[args.indexOf('--prompt') + 1];
    assert.equal(prompt, capPromptForWidget(`Deploy the fix? ${'x'.repeat(600)}`));
    assert.ok(prompt.length <= 500);
  });

  it('mirrors to the FIRST task id only', async () => {
    const c = makeChild();
    const { deps, spawns } = makeDeps(c);
    const done = mirrorAskAsWidget({
      taskIds: ['vi-111111111111', 'vi-222222222222'],
      kind: 'confirm',
      prompt: 'Go ahead?',
    }, deps);
    c.stdout('{"ok":true}');
    c.close(0);
    const result = await done;

    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].args[spawns[0].args.indexOf('--task') + 1], 'vi-111111111111');
    assert.equal(result.ok, true);
    assert.equal(result.taskId, 'vi-111111111111');
  });

  it('parses a failure JSON line into ok:false with the error text', async () => {
    const c = makeChild();
    const { deps, spawns } = makeDeps(c);
    const done = mirrorAskAsWidget({ taskIds: [TASK_ID], kind: 'confirm', prompt: 'Go?' }, deps);
    c.stdout(`{"ok":false,"error":"task ${TASK_ID} is awaiting_input; input requests are created from running"}`);
    c.close(0);
    const result = await done;

    assert.equal(result.ok, false);
    assert.equal(result.taskId, TASK_ID);
    assert.ok(result.error?.includes('awaiting_input'));
  });

  it('a nonzero exit surfaces the stderr tail, not a fake success', async () => {
    const c = makeChild();
    const { deps } = makeDeps(c);
    const done = mirrorAskAsWidget({ taskIds: [TASK_ID], kind: 'confirm', prompt: 'Go?' }, deps);
    c.stderr('ledger missing: start the server first');
    c.close(1);
    const result = await done;

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('exited 1'));
    assert.ok(result.error?.includes('ledger missing'));
  });

  it('the timeout kills the child and resolves {ok:false, error:"timeout"}', async () => {
    const c = makeChild();
    const spawns: CapturedSpawn[] = [];
    const done = mirrorAskAsWidget(
      { taskIds: [TASK_ID], kind: 'confirm', prompt: 'Go?' },
      { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return c.child; }, timeoutMs: 50 },
    );
    // No stdout, no close — the child hangs until the timeout fires.
    const result = await done;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.ok(c.killed(), 'the hung child is killed');
  });

  it('never throws: no task ids or a throwing spawnFn resolve as failures', async () => {
    const empty = await mirrorAskAsWidget(
      { taskIds: [], kind: 'confirm', prompt: 'Go?' },
      { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn: () => { throw new Error('unreachable'); } },
    );
    assert.equal(empty.ok, false);
    assert.ok(empty.error?.includes('no voice task id'));

    const boom = await mirrorAskAsWidget(
      { taskIds: [TASK_ID], kind: 'confirm', prompt: 'Go?' },
      { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn: () => { throw new Error('spawn blew up'); } },
    );
    assert.equal(boom.ok, false);
    assert.ok(boom.error?.includes('spawn blew up'));
  });

  it('resolves the script path in production shape (no scriptPath dep) — no bare __dirname', async () => {
    // Repo root: tests -> dist -> telegram-bot -> projects -> repo root (5 dirname hops).
    const repoRoot = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
    const expectedScript = join(repoRoot, 'projects', 'voice-inbox', 'scripts', 'task_input.py');
    const c = makeChild();
    const spawns: CapturedSpawn[] = [];
    const done = mirrorAskAsWidget(
      { taskIds: [TASK_ID], kind: 'confirm', prompt: 'Go?' },
      { pythonCmd: 'py', spawnFn: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return c.child; } },
    );
    c.stdout('{"ok":true,"request_id":"rq-t1"}');
    c.close(0);
    const result = await done;

    assert.equal(spawns.length, 1, 'spawn must fire exactly once in production shape');
    assert.equal(result.ok, true);
    assert.equal(result.requestId, 'rq-t1');
    assert.equal(spawns[0].args[0], expectedScript);
    assert.equal(spawns[0].args[1], 'create');
  });

  it('a null exit code (killed by signal) is a failure, not a fake success', async () => {
    const c = makeChild();
    const { deps } = makeDeps(c);
    const done = mirrorAskAsWidget({ taskIds: [TASK_ID], kind: 'confirm', prompt: 'Go?' }, deps);
    c.close(null);
    const result = await done;

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('task_input.py'), 'the failure names the script');
  });
});

describe('cancelMirroredAsk', () => {
  it('spawns cancel with the exact argv and resolves ok on the success JSON', async () => {
    const c = makeChild();
    const { deps, spawns } = makeDeps(c);
    const done = cancelMirroredAsk(TASK_ID, deps);
    c.stdout(`{"ok":true,"task_id":"${TASK_ID}","cancelled":2,"task_state":"running"}`);
    c.close(0);
    const result = await done;

    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].args, [SCRIPT, 'cancel', '--task', TASK_ID]);
    assert.deepEqual(spawns[0].opts, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    assert.deepEqual(result, { ok: true });
  });

  it('surfaces the failure JSON and never throws', async () => {
    const c = makeChild();
    const { deps } = makeDeps(c);
    const done = cancelMirroredAsk(TASK_ID, deps);
    c.stdout('{"ok":false,"error":"task not found: vi-1234567890ab"}');
    c.close(0);
    const result = await done;

    assert.equal(result.ok, false);
    assert.ok(result.error?.includes('task not found'));

    const absent = await cancelMirroredAsk('', { pythonCmd: 'py', scriptPath: SCRIPT, spawnFn: () => makeChild().child });
    assert.equal(absent.ok, false);
  });
});
