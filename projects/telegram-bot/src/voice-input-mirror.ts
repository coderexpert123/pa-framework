/**
 * Voice-inbox ask mirroring — button parity (2026-09-11 design).
 *
 * Wherever the bot arms an operator-facing confirm/question for a VOICE-ROUTED
 * conversation, the SAME typed widget is created in the voice-inbox ledger via
 * the sanctioned `task_input.py create` contract, so a widget the operator
 * misses on the Telegram side is still answerable in the app (and vice versa:
 * the answer paths cancel the mirrored widget through `task_input.py cancel`).
 *
 * Best-effort at every call site: NOTHING in this module ever throws — a
 * failed spawn, a timeout or an unparseable answer comes back as
 * `{ ok: false, error }` and the caller's reply proceeds unchanged.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

export type AskMirrorKind = 'confirm' | 'choice';

export interface AskMirrorInput {
  /** Mirror to the FIRST id; more than one is logged as an ambiguous batch. */
  taskIds: string[];
  kind: AskMirrorKind;
  /** Widget copy; capPromptForWidget clamps to 500 before the spawn. */
  prompt: string;
  /** choice only; the caller validates 1..4 strings of 1..40 chars
   *  (task_input.py's exact-key validator is the backstop). */
  options?: string[];
  /** Optional event summary (task_input.py clamps to 200). */
  summary?: string;
}

export interface AskMirrorResult {
  ok: boolean;
  taskId: string;
  requestId?: string;
  error?: string;
}

export interface MirrorSpawnOptions {
  windowsHide: boolean;
  stdio: ['ignore', 'pipe', 'pipe'];
  shell: false;
}

/** The structural slice of a ChildProcess the mirror consumes — the injection
 *  seam a fake spawn satisfies without a real process. */
export interface MirrorChild {
  stdout: { on(event: 'data', listener: (chunk: string | Buffer) => void): void };
  stderr: { on(event: 'data', listener: (chunk: string | Buffer) => void): void };
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): void;
  kill(): void;
}

export type MirrorSpawnFn = (
  command: string,
  args: string[],
  options: MirrorSpawnOptions
) => MirrorChild;

export interface MirrorDeps {
  pythonCmd?: string;
  scriptPath?: string;
  spawnFn?: MirrorSpawnFn;
  /** Test seam; production is the frozen 5 s. */
  timeoutMs?: number;
}

const SCRIPT_REL = join('projects', 'voice-inbox', 'scripts', 'task_input.py');
const MIRROR_TIMEOUT_MS = 5_000;
const STDOUT_CAP_CHARS = 8 * 1024;
const WIDGET_PROMPT_MAX = 500;
// The task lane's confirm sentence, tolerant to the * emphasis markers and to
// a missing final period.
const CONFIRM_SENTENCE_RE =
  /\s*Reply\s*\*?yes\*?\s+to\s+confirm\s+or\s+\*?no\*?\s+to\s+cancel\.?\s*$/i;

/**
 * Strip the trailing "Reply *yes* to confirm or *no* to cancel." sentence (a
 * Telegram-side gesture that means nothing inside the app's widget), trim,
 * and clamp to 500 chars — the widget contract's PROMPT_MAX — with a single
 * `…` when cut.
 */
export function capPromptForWidget(text: string): string {
  const stripped = text.replace(CONFIRM_SENTENCE_RE, '').trim();
  if (stripped.length <= WIDGET_PROMPT_MAX) return stripped;
  return stripped.slice(0, WIDGET_PROMPT_MAX - 1) + '…';
}

let cachedScriptPath: string | undefined;

/**
 * Repo-rooted path to task_input.py, found by walking up from __dirname (max
 * 5 parents) — works from BOTH src/ and dist/. Cached at module level after
 * the first hit. Undefined when the checkout layout is not what we expect.
 */
export function voiceInboxScriptPath(): string | undefined {
  if (cachedScriptPath) return cachedScriptPath;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hops = 0; hops <= 5; hops++) {
    const candidate = join(dir, SCRIPT_REL);
    if (existsSync(candidate)) {
      cachedScriptPath = candidate;
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function firstJsonLine(text: string): Record<string, unknown> | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON — keep scanning; the emit contract is one JSON line.
    }
  }
  return undefined;
}

/**
 * Spawn `python <script> <args...>`, collect stdout (capped at 8 KiB) and
 * stderr, and resolve on close/error or the 5 s timeout (kill + `timeout`).
 * NEVER throws — every failure path resolves `{ ok: false, error }`.
 */
async function runTaskInput(
  args: string[],
  deps: MirrorDeps | undefined
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const cmd = deps?.pythonCmd ?? resolvePythonCommand(process.env);
  const timeoutMs = deps?.timeoutMs ?? MIRROR_TIMEOUT_MS;
  const spawnFn: MirrorSpawnFn = deps?.spawnFn ?? ((command, cArgs, options) => spawn(command, cArgs, options));
  return new Promise((resolve) => {
    let child: MirrorChild;
    try {
      child = spawnFn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
      return;
    }
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result: { ok: true; stdout: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Best-effort kill; the timeout result stands either way.
      }
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (settled || stdout.length >= STDOUT_CAP_CHARS) return;
      stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (stdout.length > STDOUT_CAP_CHARS) stdout = stdout.slice(0, STDOUT_CAP_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ ok: false, error: (err as Error).message });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().slice(0, 200);
        finish({ ok: false, error: `task_input.py exited ${code ?? 'null'}${tail ? `: ${tail}` : ''}` });
        return;
      }
      finish({ ok: true, stdout });
    });
  });
}

function emitToResult(
  stdout: string,
  taskId: string
): { ok: true; taskId: string; requestId?: string } | { ok: false; taskId: string; error: string } {
  const parsed = firstJsonLine(stdout);
  if (parsed && parsed.ok === true) {
    const requestId = typeof parsed.request_id === 'string' ? parsed.request_id : undefined;
    return { ok: true, taskId, ...(requestId ? { requestId } : {}) };
  }
  const error = parsed && typeof parsed.error === 'string'
    ? parsed.error
    : 'unparseable task_input.py output';
  return { ok: false, taskId, error };
}

/**
 * Create the typed widget for an operator-facing ask via
 * `task_input.py create`. Mirrors to the FIRST task id (an ambiguous batch is
 * logged, never fanned out). Best-effort by contract: resolves
 * `{ ok: false, error }` on every failure, never throws.
 */
export async function mirrorAskAsWidget(
  input: AskMirrorInput,
  deps?: MirrorDeps
): Promise<AskMirrorResult> {
  const taskId = input.taskIds[0] ?? '';
  try {
    if (input.taskIds.length > 1) {
      logger.info('voice-input-mirror', `ambiguous batch: mirroring the ask to the first of ${input.taskIds.length} voice task ids`, {
        taskIds: input.taskIds,
      });
    }
    if (!taskId) return { ok: false, taskId, error: 'no voice task id' };
    const script = deps?.scriptPath ?? voiceInboxScriptPath();
    if (!script) return { ok: false, taskId, error: 'task_input.py not found' };
    const args = [script, 'create', '--task', taskId, '--kind', input.kind, '--prompt', capPromptForWidget(input.prompt)];
    if (input.kind === 'choice' && input.options && input.options.length > 0) {
      args.push('--param', `options=${JSON.stringify(input.options)}`);
    }
    if (input.summary) args.push('--summary', input.summary);
    const run = await runTaskInput(args, deps);
    if (!run.ok) return { ok: false, taskId, error: run.error };
    return emitToResult(run.stdout, taskId);
  } catch (err) {
    return { ok: false, taskId, error: (err as Error).message };
  }
}

/**
 * Withdraw the mirrored widget for one task via `task_input.py cancel` — the
 * reverse-clear the Telegram-side answer paths run so the app badge cannot
 * lie. Fire-and-forget friendly; never throws.
 */
export async function cancelMirroredAsk(
  taskId: string,
  deps?: MirrorDeps
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!taskId) return { ok: false, error: 'no voice task id' };
    const script = deps?.scriptPath ?? voiceInboxScriptPath();
    if (!script) return { ok: false, error: 'task_input.py not found' };
    const run = await runTaskInput([script, 'cancel', '--task', taskId], deps);
    if (!run.ok) return { ok: false, error: run.error };
    const parsed = firstJsonLine(run.stdout);
    if (parsed && parsed.ok === true) return { ok: true };
    return {
      ok: false,
      error: parsed && typeof parsed.error === 'string' ? parsed.error : 'unparseable task_input.py output',
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
