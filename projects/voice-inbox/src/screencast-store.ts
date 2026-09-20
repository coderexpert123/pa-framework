/**
 * Live screencast frame store (AI-246, WP-A): the ONLY surface a streamed
 * browser frame ever touches — in-memory, one frame per task, TTL-evicted,
 * NEVER on disk. Frames are sensitive by design: nothing under
 * files/<task_id>/, or anywhere else, persists them.
 *
 * The bridge (scripts/screencast_bridge.mjs) POSTs the newest JPEG over and
 * over; the PWA polls for the latest. There is no history and no append —
 * putFrame REPLACES, so a burst can never grow memory (one frame ≤ maxBytes
 * per task id). Stale entries are evicted on every read (getFrame/has/meta)
 * AND by a single unref'd sweeper, so the map cannot accumulate dead entries
 * between polls and the interval never holds the process open.
 */

export interface ScreencastFrameMeta {
  width?: number | null;
  height?: number | null;
}

export interface ScreencastFrame {
  buf: Buffer;
  /** Epoch ms of the last putFrame — freshness is read against this. */
  ts: number;
  width: number | null;
  height: number | null;
}

/** GET /api/v1/live/:taskId payload fields — live:false carries nulls. */
export interface ScreencastStatusMeta {
  live: boolean;
  ts: number | null;
  width: number | null;
  height: number | null;
}

export interface ScreencastStore {
  /** Replace the task's frame. Rejects over maxBytes (false → caller 413s);
   *  never appends — only the newest frame is kept. */
  putFrame(taskId: string, buf: Buffer, meta?: ScreencastFrameMeta): boolean;
  /** The fresh frame, or undefined — a stale entry is evicted on the way out. */
  getFrame(taskId: string): ScreencastFrame | undefined;
  /** TTL-checked existence — drives taskDetail's `live` flag. */
  has(taskId: string): boolean;
  /** Status-route meta: {live:false, ts/width/height:null} when no fresh frame. */
  meta(taskId: string): ScreencastStatusMeta;
  /** Drop the task's frame (the bridge's best-effort shutdown DELETE). */
  clear(taskId: string): void;
  /** Stop the sweeper — tests call this so the interval cannot leak. */
  stop(): void;
}

export interface ScreencastStoreOptions {
  /** Freshness window in ms — a frame older than this reads as absent. */
  ttlMs: number;
  /** Per-frame byte cap; putFrame rejects over it. */
  maxBytes: number;
  /** Clock seam for tests (defaults to Date.now). */
  now?: () => number;
  /** Sweeper cadence in ms (default 10_000; the interval is unref'd). */
  sweepMs?: number;
}

export function createScreencastStore(options: ScreencastStoreOptions): ScreencastStore {
  const { ttlMs, maxBytes } = options;
  const now = options.now ?? Date.now;
  const frames = new Map<string, ScreencastFrame>();

  const isFresh = (entry: ScreencastFrame): boolean => now() - entry.ts < ttlMs;

  const evictStale = (): void => {
    for (const [taskId, entry] of frames) {
      if (!isFresh(entry)) frames.delete(taskId);
    }
  };

  const sweeper = setInterval(evictStale, options.sweepMs ?? 10_000);
  sweeper.unref();

  const getFrame = (taskId: string): ScreencastFrame | undefined => {
    const entry = frames.get(taskId);
    if (entry === undefined) return undefined;
    if (!isFresh(entry)) {
      frames.delete(taskId);
      return undefined;
    }
    return entry;
  };

  return {
    putFrame(taskId, buf, meta = {}) {
      if (buf.length > maxBytes) return false;
      frames.set(taskId, {
        buf,
        ts: now(),
        width: meta.width ?? null,
        height: meta.height ?? null,
      });
      return true;
    },
    getFrame,
    has(taskId) {
      return getFrame(taskId) !== undefined;
    },
    meta(taskId) {
      const entry = getFrame(taskId);
      return {
        live: entry !== undefined,
        ts: entry?.ts ?? null,
        width: entry?.width ?? null,
        height: entry?.height ?? null,
      };
    },
    clear(taskId) {
      frames.delete(taskId);
    },
    stop() {
      clearInterval(sweeper);
    },
  };
}
