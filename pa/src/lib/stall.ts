/**
 * Bounded in-process serializers and the stall registry (catchup-lane-wedge
 * wave, 2026-09-16).
 *
 * Every in-process FIFO serializer in pa/src/lib (log appends, the maintenance
 * ledger, archive rotation, reservations, topic tasks, watch jobs, the agent
 * bus) and pa/src/rate-limits.ts queue through withBoundedQueue. A caller waits for its predecessor only
 * while the predecessor's own operation has been running for less than the
 * bound (PA_STORE_WAIT_MAX_MS, default 180 s). Past the bound the caller
 * detaches, a stall record is appended SYNCHRONOUSLY to
 * ~/.pa/stall-records.jsonl, every onStall listener is told, and the caller
 * proceeds. The hung operation is never cancelled (JavaScript cannot) and never
 * awaited again. The bound is per predecessor operation, not per total queue
 * wait: a long queue of slow-but-settling operations never records a stall.
 *
 * AI-315: a predecessor whose OWN wait already expired propagates the detach —
 * its successors proceed immediately rather than re-paying a full bound per
 * link. Before this, a wedged queue head made every successor wait
 * predecessor-start + bound, so N queued writes cost ~N×bound (observed: 960 s
 * waits on a 180 s bound), and a serial consumer such as a maintenance pass
 * starved every job after the wedge point.
 *
 * A detach is evidence, not recovery. A host that registers a listener (the
 * catchup loop) exits for relaunch; zero listeners is valid (CLI one-shots,
 * the bot in this wave).
 *
 * DO NOT import lib/log.ts or anything that logs or locks: log.ts is a
 * consumer, and a wedged logger must never block stall evidence.
 */
import { appendFileSync, mkdirSync, statSync } from 'fs';
import { randomBytes } from 'crypto';
import { basename, dirname, join } from 'path';
import { paHome } from '../paths.js';

export const DEFAULT_STORE_WAIT_MAX_MS = 180_000;
export const STALL_RECORDS_MAX_BYTES = 1_048_576;
export const STALL_RECORDS_ARCHIVE_SUFFIX = '-stall-records.jsonl';

export function readStoreWaitMaxMs(): number {
  const n = Number(process.env.PA_STORE_WAIT_MAX_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STORE_WAIT_MAX_MS;
}

export function stallRecordsPath(): string {
  return join(paHome(), 'stall-records.jsonl');
}

export interface StallRecord {
  ts: string;
  pid: number;
  host: string;
  store: string;
  target: string;
  waitedMs: number;
  maxWaitMs: number;
  refId: string;
}

export type StallListener = (record: StallRecord) => void;

export interface BoundedQueueOptions {
  /** Stable store label written to the stall record, e.g. 'app-log'. */
  store: string;
  /** File basename (never a full path) or another short target label. */
  target?: string;
  /** Default: readStoreWaitMaxMs() at enqueue time. */
  maxWaitMs?: number;
}

const listeners = new Set<StallListener>();
let hostLabel: string | undefined;

export function onStall(listener: StallListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setStallHost(label: string): void {
  hostLabel = label;
}

function defaultHostLabel(): string {
  const script = process.argv[1] ? basename(process.argv[1]) : 'node';
  const sub = process.argv[2] ?? '';
  return `${script}${sub ? ` ${sub}` : ''}`.replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 60);
}

/** Test-only: forget listeners and the host label. */
export function _resetStallStateForTest(): void {
  listeners.clear();
  hostLabel = undefined;
}

interface QueueEntry {
  /** Resolves when this entry's fn() begins — whether normally (its
   *  predecessor settled inside the bound) or by detach (its own wait
   *  expired). `detached` lets successors propagate the detach instead of
   *  re-paying a bound (AI-315). */
  started: Promise<{ at: number; detached: boolean }>;
  settled: Promise<void>;
}

const queues = new Map<string, QueueEntry>();

/** Test-only: drop one queue's tail so the next caller has no predecessor. */
export function _resetBoundedQueueForTest(key: string): void {
  queues.delete(key);
}

export function withBoundedQueue<T>(key: string, fn: () => Promise<T>, opts: BoundedQueueOptions): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? readStoreWaitMaxMs();
  const predecessor = queues.get(key);
  let markStarted!: (v: { at: number; detached: boolean }) => void;
  let markSettled!: () => void;
  const entry: QueueEntry = {
    started: new Promise<{ at: number; detached: boolean }>((resolve) => {
      markStarted = resolve;
    }),
    settled: new Promise<void>((resolve) => {
      markSettled = resolve;
    }),
  };
  queues.set(key, entry);
  const enqueuedAt = Date.now();
  return (async () => {
    let detached = false;
    try {
      if (predecessor) detached = await waitForPredecessor(predecessor, maxWaitMs, opts, enqueuedAt);
      markStarted({ at: Date.now(), detached });
      return await fn();
    } finally {
      markStarted({ at: Date.now(), detached });
      markSettled();
      if (queues.get(key) === entry) queues.delete(key);
    }
  })();
}

/**
 * Waits for the CURRENT tail of `key`'s queue to settle, without joining the
 * queue — the drain primitive for flush-style callers (flushLog). Unlike a
 * queued no-op entry, this resolves only once every operation enqueued so far
 * has actually finished, and it never inherits a detach (a detached queue
 * must not let a flush return while a predecessor's write is still in
 * flight). Bounded by maxWaitMs so a hung tail can't block the caller
 * forever; resolves void either way.
 */
export async function waitForQueueDrain(key: string, maxWaitMs: number = readStoreWaitMaxMs()): Promise<void> {
  const tail = queues.get(key);
  if (!tail) return;
  // Wait for the tail to START first, then bound its run by start+maxWait —
  // the same schedule a queued predecessor gets. A flat maxWaitMs from here
  // can expire before a still-waiting tail has even begun its operation.
  const started = await tail.started;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    tail.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, started.at + maxWaitMs - Date.now()));
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Returns true when this caller detached (its wait expired or its predecessor
 *  had already detached) — propagated into this entry's own `started` so the
 *  next link detaches immediately instead of re-paying a bound. */
async function waitForPredecessor(
  predecessor: QueueEntry,
  maxWaitMs: number,
  opts: BoundedQueueOptions,
  enqueuedAt: number,
): Promise<boolean> {
  const pred = await predecessor.started;
  if (pred.detached) {
    // The predecessor's own wait already expired: the queue is wedged
    // somewhere upstream. Proceeding immediately keeps the detach at ~one
    // bound for the whole chain (AI-315) — the store's real lock still
    // serializes the underlying operations.
    recordStall(opts, Date.now() - enqueuedAt, maxWaitMs);
    return true;
  }
  let timer: NodeJS.Timeout | undefined;
  const expired = await Promise.race([
    predecessor.settled.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(0, pred.at + maxWaitMs - Date.now()));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (expired) recordStall(opts, Date.now() - pred.at, maxWaitMs);
  return expired;
}

function recordStall(opts: BoundedQueueOptions, waitedMs: number, maxWaitMs: number): void {
  const record: StallRecord = {
    ts: new Date().toISOString(),
    pid: process.pid,
    host: hostLabel ?? defaultHostLabel(),
    store: opts.store,
    target: opts.target ?? '',
    waitedMs,
    maxWaitMs,
    refId: `s-${randomBytes(6).toString('hex')}`,
  };
  const path = stallRecordsPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size < STALL_RECORDS_MAX_BYTES) {
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    } else {
      console.error(`[stall] ${path} is at or over ${STALL_RECORDS_MAX_BYTES} bytes; record ${record.refId} not persisted`);
    }
  } catch (err: any) {
    console.error(`[stall] could not persist stall record ${record.refId}: ${err?.message ?? String(err)}`);
  }
  console.error(
    `[stall] ${record.store}${record.target ? ` (${record.target})` : ''}: predecessor unsettled after ${waitedMs}ms; detached (${record.refId})`,
  );
  for (const listener of [...listeners]) {
    try {
      listener(record);
    } catch {
      /* a listener never breaks the queue */
    }
  }
}
