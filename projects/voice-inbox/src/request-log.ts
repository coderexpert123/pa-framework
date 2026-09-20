/**
 * Request logging (2026-09-08 incident follow-up): one JSONL line per HTTP
 * request under ~/.pa/voice-inbox/logs/requests.log — observation only. No
 * headers, no bodies, no query-string VALUES (keys only — redactPathForLog).
 * Writes are fire-and-forget and never throw into the request handler; a
 * failure degrades to console.error. Rotation is an append-time size cap
 * (5MB → requests-<stamp>.log, newest 4 kept) — pa's archive pruner is
 * deliberately NOT involved (its suffix allowlist would keep these shards
 * forever) and this package never imports pa/dist.
 */

import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface RequestLogEntry {
  /** ISO-8601 UTC at request START. */
  ts: string;
  method: string;
  /** Already redacted (query keys only). */
  path: string;
  status: number;
  bytes_in: number;
  bytes_out: number;
  ms: number;
  session_ok: boolean;
}

export const REQUEST_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const REQUEST_LOG_KEEP_SHARDS = 4;
const SHARD_RE = /^requests-\d{8}-\d{6}(-\d+)?\.log$/;

/** Path + query KEYS only — values never reach the log. */
export function redactPathForLog(pathname: string, query: URLSearchParams): string {
  const keys = [...query.keys()];
  if (keys.length === 0) return pathname;
  return `${pathname}?${keys.map((k) => encodeURIComponent(k)).join('&')}`;
}

/** One JSONL line; key order is a pinned assertion target — never reorder. */
export function formatRequestLogLine(entry: RequestLogEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    method: entry.method,
    path: entry.path,
    status: entry.status,
    bytes_in: entry.bytes_in,
    bytes_out: entry.bytes_out,
    ms: entry.ms,
    session_ok: entry.session_ok,
  });
}

/**
 * Per-write appendFile (open/close each line) — NO long-lived handle. That is
 * load-bearing: rotation renames the file between writes, which Windows
 * forbids while a handle is open.
 */
function defaultAppend(logPath: string): (path: string, line: string) => Promise<void> {
  const dir = dirname(logPath);
  let dirEnsured = false;
  return async (path, line) => {
    if (!dirEnsured) {
      await mkdir(dir, { recursive: true });
      dirEnsured = true;
    }
    await appendFile(path, line + '\n', 'utf8');
  };
}

function shardStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function rotateIfNeeded(
  logPath: string,
  upcomingBytes: number,
  maxBytes: number,
  keepShards: number,
  now: () => Date
): Promise<void> {
  let size = 0;
  try {
    size = (await stat(logPath)).size;
  } catch {
    return; // absent → nothing to rotate; the next append creates it
  }
  if (size + upcomingBytes <= maxBytes) return;
  const dir = dirname(logPath);
  const base = shardStamp(now());
  let target = join(dir, `requests-${base}.log`);
  for (let i = 1; (await stat(target).then(() => true, () => false)) === true; i++) {
    target = join(dir, `requests-${base}-${i}.log`);
  }
  await rename(logPath, target);
  // No empty-file recreation: the next appendFile creates it (one less write,
  // and a failed next write never leaves an empty shard set lying about).
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const shards: { path: string; mtimeMs: number }[] = [];
  for (const n of names) {
    if (!SHARD_RE.test(n)) continue;
    const p = join(dir, n);
    try {
      shards.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
    } catch {
      /* raced away — skip */
    }
  }
  shards.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const s of shards.slice(keepShards)) {
    try {
      await unlink(s.path);
    } catch {
      /* best-effort; a Windows-held shard retries on a later rotation */
    }
  }
}

export interface RequestLoggerDeps {
  /** Test seam — replaces the append primitive; rotation still runs. */
  appendImpl?: (path: string, line: string) => Promise<void>;
  now?: () => Date;
  maxBytes?: number;
  keepShards?: number;
}

/**
 * Returns a SYNCHRONOUS void logger: callers never await it (never-block) and
 * it never throws (never-throw-into-the-handler). Writes drain through an
 * internal promise chain so line ORDER is preserved; any failure is reported
 * on console.error once per failed write and the chain stays resolved.
 */
export function createRequestLogger(
  logPath: string,
  deps: RequestLoggerDeps = {}
): (entry: RequestLogEntry) => void {
  const append = deps.appendImpl ?? defaultAppend(logPath);
  const maxBytes = deps.maxBytes ?? REQUEST_LOG_MAX_BYTES;
  const keepShards = deps.keepShards ?? REQUEST_LOG_KEEP_SHARDS;
  const now = deps.now ?? (() => new Date());
  let chain: Promise<void> = Promise.resolve();
  return (entry: RequestLogEntry): void => {
    const line = formatRequestLogLine(entry);
    chain = chain
      .then(() =>
        rotateIfNeeded(logPath, Buffer.byteLength(line) + 1, maxBytes, keepShards, now).then(() =>
          append(logPath, line)
        )
      )
      .catch((e: unknown) => {
        console.error(
          `voice-inbox: request log write failed: ${e instanceof Error ? e.message : String(e)}`
        );
      });
  };
}
