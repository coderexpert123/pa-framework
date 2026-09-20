/**
 * Voice-inbox Telegram message_id capture (AI-218).
 *
 * After the bot posts a voice task's result to the routed topic as an FYI
 * reply, `sendReplyText` resolves `{ delivered, messageId }` — the Telegram
 * `message_id` of the first chunk. That id is the deep-link anchor the
 * voice-inbox app needs to navigate straight to the FYI
 * (`https://t.me/c/<chatId>/<threadId>/<messageId>`). This module writes it
 * back to the ledger's `tasks.tg_message_id` (schema v11) via the sanctioned
 * `scripts/task_set_message_id.py` worker script — the same cross-process
 * channel `voice-input-mirror.ts` uses for ask mirroring (a python script
 * that opens the API server's SQLite file directly; the bot never touches the
 * DB itself).
 *
 * Best-effort by contract: NOTHING in this module ever throws — a failed
 * spawn, a timeout, an unknown task or an unparseable answer resolves
 * `{ ok: false, error }` per task and the caller's reply proceeds unchanged.
 * A lost message_id loses a deep-link anchor, never the delivered reply.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import type { MirrorChild, MirrorDeps, MirrorSpawnFn } from './voice-input-mirror.js';

export interface MessageIdCaptureResult {
  taskId: string;
  ok: boolean;
  error?: string;
}

const SCRIPT_REL = join('projects', 'voice-inbox', 'scripts', 'task_set_message_id.py');
const CAPTURE_TIMEOUT_MS = 5_000;
const STDOUT_CAP_CHARS = 8 * 1024;

let cachedScriptPath: string | undefined;

/**
 * Repo-rooted path to task_set_message_id.py, found by walking up from
 * __dirname (max 5 parents) — works from BOTH src/ and dist/. Cached at module
 * level after the first hit. Undefined when the checkout layout is not what we
 * expect.
 */
export function voiceMessageIdScriptPath(): string | undefined {
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
 * Spawn `python <script> --task <id> --message-id <n>`, collect stdout (capped
 * at 8 KiB) and stderr, and resolve on close/error or the 5 s timeout (kill +
 * `timeout`). NEVER throws — every failure path resolves `{ ok: false, error }`.
 */
async function runSetMessageId(
  args: string[],
  deps: MirrorDeps | undefined
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const cmd = deps?.pythonCmd ?? resolvePythonCommand(process.env);
  const timeoutMs = deps?.timeoutMs ?? CAPTURE_TIMEOUT_MS;
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
        finish({ ok: false, error: `task_set_message_id.py exited ${code ?? 'null'}${tail ? `: ${tail}` : ''}` });
        return;
      }
      finish({ ok: true, stdout });
    });
  });
}

/**
 * Write the Telegram `messageId` back to the ledger for every voice task id
 * the turn named. One spawn per task (the script takes a single --task); a
 * batched turn that named several tasks fans out. Best-effort: each spawn
 * resolves `{ ok, error? }` and never throws — a failure for one task is
 * logged and does not abort the others. Returns one result per task id, in
 * order. An empty list or a null/non-integer messageId is a no-op (resolves
 * an empty array) so the call site needs no guard.
 */
export async function captureTaskMessageIds(
  taskIds: string[],
  messageId: number | null,
  deps?: MirrorDeps
): Promise<MessageIdCaptureResult[]> {
  if (!Number.isInteger(messageId) || taskIds.length === 0) return [];
  const script = deps?.scriptPath ?? voiceMessageIdScriptPath();
  if (!script) {
    logger.warn('voice-message-id-capture', 'task_set_message_id.py not found; skipping capture', {});
    return taskIds.map((taskId) => ({ taskId, ok: false, error: 'task_set_message_id.py not found' }));
  }
  const results: MessageIdCaptureResult[] = [];
  for (const taskId of taskIds) {
    try {
      const run = await runSetMessageId([script, '--task', taskId, '--message-id', String(messageId)], deps);
      if (!run.ok) {
        results.push({ taskId, ok: false, error: run.error });
        continue;
      }
      const parsed = firstJsonLine(run.stdout);
      if (parsed && parsed.ok === true) {
        results.push({ taskId, ok: true });
      } else {
        const error = parsed && typeof parsed.error === 'string' ? parsed.error : 'unparseable task_set_message_id.py output';
        results.push({ taskId, ok: false, error });
      }
    } catch (err) {
      results.push({ taskId, ok: false, error: (err as Error).message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    logger.warn('voice-message-id-capture', `capture failed for ${failed.length}/${results.length} task(s)`, {
      messageId,
      failed: failed.map((r) => ({ taskId: r.taskId, error: r.error })),
    });
  }
  return results;
}
