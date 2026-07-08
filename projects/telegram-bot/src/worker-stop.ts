/**
 * /stop and /steer — in-topic worker interruption (AI-092).
 *
 * Both commands are intercepted in the POLL LOOP, before per-topic
 * serialization: the whole point is to act while a dispatch for this topic is
 * still running, and anything routed through the normal chain would queue
 * behind that dispatch and fire only after the worker finished on its own.
 *
 * Kill path: the worker-pids registry (skill = `topic-<chatId>_<threadId>`)
 * gives us the shell-wrapper PID and its heartbeat-persisted descendants;
 * every alive PID in that set is process-tree-killed.
 *
 * Suppression: the killed dispatch's `executeWorker` resolves with a non-zero
 * exit, which would normally send a "worker error" reply. `markTopicStopped`
 * records the intent so that (a) `dispatchMessage` aborts instead of failing
 * over to a fresh worker for a request the user just cancelled, and (b) the
 * reply path swaps the error text for a clean "⏹ Stopped." (or silence, for
 * /steer — the steer prompt's own dispatch produces the next reply).
 */
import { listWorkerPids, removeWorkerPid, isProcessAlive } from '../../../pa/dist/src/worker-pids.js';
import { killProcessTree } from '../../../pa/dist/src/process-tree.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

export type StopKind = 'stop' | 'steer';

export const STOP_MARKER_TTL_MS = 5 * 60 * 1000;

// Marker per topic. `sinceUpdateId` scopes it to dispatches OLDER than the
// /stop//steer message itself: without that gate a lingering marker (e.g. the
// killed dispatch never surfaced an error to consume it) would silently abort
// or mute the user's NEXT message in the topic.
const stopped = new Map<string, { kind: StopKind; at: number; sinceUpdateId: number }>();

export function markTopicStopped(topicKey: string, kind: StopKind, sinceUpdateId: number, now: number = Date.now()): void {
  stopped.set(topicKey, { kind, at: now, sinceUpdateId });
}

/** Remove a marker (e.g. the kill turned out to be a no-op). */
export function unmarkTopicStopped(topicKey: string): void {
  stopped.delete(topicKey);
}

function validEntry(topicKey: string, updateId: number | undefined, now: number) {
  const entry = stopped.get(topicKey);
  if (!entry) return null;
  if (now - entry.at > STOP_MARKER_TTL_MS) {
    stopped.delete(topicKey);
    return null;
  }
  // updateId undefined → caller has no update context; treat as targeted.
  if (updateId !== undefined && updateId >= entry.sinceUpdateId) return null;
  return entry;
}

/** Non-destructive check — used by dispatchMessage to abort failover respawns. */
export function isTopicStopped(topicKey: string, updateId?: number, now: number = Date.now()): boolean {
  return validEntry(topicKey, updateId, now) !== null;
}

/**
 * Destructive read for the reply path. Consumes the marker only when it
 * targets this dispatch (updateId older than the /stop) — a newer dispatch
 * leaves the marker in place for the one it was actually aimed at.
 */
export function consumeTopicStopped(topicKey: string, updateId?: number, now: number = Date.now()): StopKind | null {
  const entry = validEntry(topicKey, updateId, now);
  if (!entry) return null;
  stopped.delete(topicKey);
  return entry.kind;
}

/** Test hook. */
export function _clearStoppedForTest(): void {
  stopped.clear();
}

export interface StopDeps {
  list: typeof listWorkerPids;
  alive: (pid: number) => boolean;
  kill: (pid: number) => void;
  removeEntry: (pid: number) => Promise<void>;
}

const defaultDeps: StopDeps = {
  list: listWorkerPids,
  alive: isProcessAlive,
  kill: killProcessTree,
  removeEntry: removeWorkerPid,
};

/**
 * Kill every live worker (wrapper + descendants) serving this topic.
 * Returns the number of PIDs killed — 0 means nothing was running.
 */
export async function stopTopicWorkers(
  chatId: number,
  threadId: number,
  deps: StopDeps = defaultDeps,
): Promise<number> {
  const resource = `topic-${chatId}_${threadId}`;
  let killed = 0;
  let entries;
  try {
    entries = await deps.list();
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.skill !== resource) continue;
    const pids = [entry.pid, ...(entry.descendants ?? [])];
    for (const pid of pids) {
      if (deps.alive(pid)) {
        try {
          deps.kill(pid);
          killed++;
        } catch { /* already gone */ }
      }
    }
    await deps.removeEntry(entry.pid).catch(() => {});
  }
  if (killed > 0) {
    logger.info('worker-stop', `killed ${killed} pid(s) for ${resource}`, { chatId, threadId });
  }
  return killed;
}

// --- Command parsing (exported for tests) -----------------------------------

export const STOP_PATTERN = /^\/stop(?:@\w+)?\s*$/i;
export const STEER_PATTERN = /^\/steer(?:@\w+)?(?:\s+([\s\S]+))?$/i;

export function parseStopSteer(text: string): { kind: StopKind; prompt?: string } | null {
  if (STOP_PATTERN.test(text)) return { kind: 'stop' };
  const m = STEER_PATTERN.exec(text);
  if (m) {
    const prompt = m[1]?.trim();
    // /steer with no prompt degrades to /stop (documented in BOT_COMMANDS).
    return prompt ? { kind: 'steer', prompt } : { kind: 'stop' };
  }
  return null;
}
