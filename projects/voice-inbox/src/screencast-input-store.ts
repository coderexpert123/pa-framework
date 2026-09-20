/**
 * Live screencast INPUT store (AI-246 v2, WP-F): the ONLY surface an
 * operator's input commands ever touch — in-memory per-task bounded queue,
 * seq-numbered, NEVER on disk. Commands are as sensitive as the frames they
 * steer (they carry the operator's taps and keystrokes into a live browser),
 * so nothing under files/<task_id>/, or anywhere else, persists them.
 *
 * The PWA (fullscreen only) POSTs one command at a time; the bridge
 * long-polls `drainSince` and injects each command over its existing CDP
 * WebSocket. Unlike the frame store there is no TTL and no sweeper:
 * commands are DRAINED by the consumer, not aged out — the only bound a
 * dead bridge needs is the queue cap, and on overflow the OLDEST queued
 * command is dropped (the freshest input always wins). `seq` is per-task
 * monotonic and survives drains and clears, so a consumer's `since` cursor
 * never collides with a re-issued number.
 */

/** The input command types the server accepts (the spec's injection table). */
export type ScreencastInputType =
  | 'tap'
  | 'doubletap'
  | 'longpress'
  | 'scroll'
  | 'pinch'
  | 'type'
  | 'key'
  | 'navigate'
  | 'back'
  | 'forward'
  | 'reload';

/** One normalized input command — the bridge maps `type` + the relevant
 *  fields to CDP calls. Only the fields the type needs are populated; the
 *  route's validator owns that shape. */
export interface ScreencastInputCommand {
  type: ScreencastInputType;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  scaleFactor?: number;
  durationMs?: number;
  text?: string;
  key?: string;
  code?: string;
  modifiers?: string[];
  url?: string;
}

/** A queued command as the bridge receives it — `seq` rides inside so the
 *  consumer can advance its `since` cursor per command. */
export interface SequencedInputCommand extends ScreencastInputCommand {
  seq: number;
}

export interface ScreencastInputDrain {
  cmds: SequencedInputCommand[];
  /** Highest seq ever assigned to this task (0 when none) — the consumer's
   *  next `since`, valid even when `cmds` came back empty. */
  maxSeq: number;
}

/** enqueue's failure vocabulary: 'rate-limited' = over the per-task
 *  per-second budget (the route's 413 "overflow"), 'invalid' = a field over
 *  the store-side length bound (defense in depth — the route validates
 *  first, so it is unreachable from the HTTP path). Queue-full is NOT a
 *  failure: overflow drops the oldest queued command and the new one still
 *  lands (spec's drop-oldest). */
export type ScreencastInputEnqueueResult = number | 'rate-limited' | 'invalid';

export interface ScreencastInputStore {
  /** Append the command; returns its monotonic seq, or a rejection tag.
   *  A full queue evicts its OLDEST entry first — enqueue never fails for
   *  fullness. */
  enqueue(taskId: string, cmd: ScreencastInputCommand): ScreencastInputEnqueueResult;
  /** Remove and return every queued command with seq > `since`, oldest
   *  first. Commands are consumed by this call — a re-read of the same
   *  cursor sees only newer arrivals. */
  drainSince(taskId: string, since: number): ScreencastInputDrain;
  /** Long-poll seam for the bridge's GET: resolves with the drain as soon
   *  as a command with seq > `since` exists, or null on timeout / clear /
   *  stop. timeoutMs 0 = a single immediate drain attempt. */
  drainSinceWait(taskId: string, since: number, timeoutMs: number): Promise<ScreencastInputDrain | null>;
  /** ms epoch of the task's most recent accepted operator input, or null. */
  lastInputAt(taskId: string): number | null;
  /** Drop the task's queued commands and release its waiters (null), but
   *  KEEP the seq counter — monotonicity survives a clear so a bridge's
   *  `since` cursor never collides with a re-issued seq. */
  clear(taskId: string): void;
  /** Release every pending waiter (null) and forget all state — tests call
   *  this so no timer can leak. */
  stop(): void;
}

export interface ScreencastInputStoreOptions {
  /** Per-task queued-command cap; overflow drops the oldest entry. */
  maxQueuePerTask: number;
  /** Store-side `text` length bound (the route enforces the same limit). */
  maxTextLen: number;
  /** Store-side `url` length bound (the route enforces the same limit). */
  maxUrlLen: number;
  /** Max successful enqueues per task inside the sliding 1 s window. */
  rateLimitPerSec: number;
  /** Clock seam for tests (defaults to Date.now). */
  now?: () => number;
}

const RATE_WINDOW_MS = 1_000;

interface QueuedCommand {
  seq: number;
  cmd: ScreencastInputCommand;
}

interface InputWaiter {
  since: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (drain: ScreencastInputDrain | null) => void;
}

interface TaskInputQueue {
  cmds: QueuedCommand[];
  /** Next seq to assign — monotonic for the life of the store; clear() and
   *  drain exhaustion both leave it untouched. */
  nextSeq: number;
  /** ms epoch of the most recent ACCEPTED enqueue — survives clear() (same
   *  rule as nextSeq: the operator-input record must outlive a queue
   *  drain/bridge restart so the resume signal still fires); stop() drops it. */
  lastInputAt: number | null;
  /** Enqueue timestamps inside the sliding rate window. */
  hits: number[];
  waiters: Set<InputWaiter>;
}

export function createScreencastInputStore(options: ScreencastInputStoreOptions): ScreencastInputStore {
  const { maxQueuePerTask, maxTextLen, maxUrlLen, rateLimitPerSec } = options;
  const now = options.now ?? Date.now;
  const queues = new Map<string, TaskInputQueue>();

  const queueFor = (taskId: string): TaskInputQueue => {
    let q = queues.get(taskId);
    if (q === undefined) {
      q = { cmds: [], nextSeq: 1, lastInputAt: null, hits: [], waiters: new Set() };
      queues.set(taskId, q);
    }
    return q;
  };

  const drainSince = (taskId: string, since: number): ScreencastInputDrain => {
    const q = queues.get(taskId);
    if (q === undefined) return { cmds: [], maxSeq: 0 };
    const keep: QueuedCommand[] = [];
    const out: SequencedInputCommand[] = [];
    for (const entry of q.cmds) {
      if (entry.seq > since) out.push({ seq: entry.seq, ...entry.cmd });
      else keep.push(entry);
    }
    q.cmds = keep;
    return { cmds: out, maxSeq: q.nextSeq - 1 };
  };

  const releaseWaiters = (taskId: string, q: TaskInputQueue): void => {
    for (const w of [...q.waiters]) {
      const drained = drainSince(taskId, w.since);
      if (drained.cmds.length === 0) continue; // not new enough for this cursor
      q.waiters.delete(w);
      clearTimeout(w.timer);
      w.resolve(drained);
    }
  };

  const failWaiters = (q: TaskInputQueue): void => {
    for (const w of q.waiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    q.waiters.clear();
  };

  return {
    enqueue(taskId, cmd) {
      if (cmd.text !== undefined && cmd.text.length > maxTextLen) return 'invalid';
      if (cmd.url !== undefined && cmd.url.length > maxUrlLen) return 'invalid';
      const q = queueFor(taskId);
      const t = now();
      q.hits = q.hits.filter((h) => t - h < RATE_WINDOW_MS);
      if (q.hits.length >= rateLimitPerSec) return 'rate-limited';
      q.hits.push(t);
      q.lastInputAt = t; // accepted input only — rejections never move it
      if (q.cmds.length >= maxQueuePerTask) q.cmds.shift(); // drop oldest on overflow
      const seq = q.nextSeq++;
      q.cmds.push({ seq, cmd });
      releaseWaiters(taskId, q);
      return seq;
    },
    drainSince,
    lastInputAt(taskId) {
      return queues.get(taskId)?.lastInputAt ?? null;
    },
    drainSinceWait(taskId, since, timeoutMs) {
      const immediate = drainSince(taskId, since);
      if (immediate.cmds.length > 0) return Promise.resolve(immediate);
      if (timeoutMs <= 0) return Promise.resolve(null);
      const q = queueFor(taskId);
      return new Promise<ScreencastInputDrain | null>((resolve) => {
        // NOT unref'd: a pending long-poll is an in-flight request, not a
        // background interval — its timer must hold the event loop (unlike
        // the frame store's sweeper, which is deliberately unref'd). stop()
        // and clear() still release it early.
        const waiter: InputWaiter = {
          since,
          timer: setTimeout(() => {
            q.waiters.delete(waiter);
            resolve(null);
          }, timeoutMs),
          resolve,
        };
        q.waiters.add(waiter);
      });
    },
    clear(taskId) {
      const q = queues.get(taskId);
      if (q === undefined) return;
      q.cmds = [];
      failWaiters(q);
    },
    stop() {
      for (const q of queues.values()) failWaiters(q);
      queues.clear();
    },
  };
}
