/**
 * Live-update event stream (vi-6b1014ea197b): the data layer behind
 * `GET /api/v1/stream` (SSE). Deliberately socket-free like routes.ts's own
 * handlers — server.ts is the only module that touches a real
 * `http.ServerResponse`; this file owns three small primitives:
 *
 *   - `createEventHub()` — a registry of connected clients (each a plain
 *     `(chunk: string) => void` writer) plus `broadcast(event)`, which is a
 *     bare invalidation ping, never a data payload. The client already
 *     re-fetches its own tenant-scoped view on receipt (the same
 *     `refreshConversations`/`refreshConversation` the 4 s poll calls) — so a
 *     ping carries no information worth tenant-scoping, and every connected
 *     client (any tenant) gets the same one.
 *   - `startChangeWatcher()` — polls `PRAGMA data_version` on its OWN sqlite
 *     connection and calls `onChange()` when it moves. Feeds a `changed`
 *     broadcast (inbox data updated — client re-fetches).
 *   - `startShellWatcher()` — polls the PWA shell's service-worker file's
 *     mtime and calls `onChange()` when it moves. Feeds a `reload` broadcast
 *     (the shell itself changed — client updates its service worker and
 *     reloads). Deliberately independent of any server restart: a static
 *     asset deploy (public/* only, no .ts change) never touches
 *     `dist/.build-stamp` and so never restarts the server process, but it
 *     still needs to reach already-open tabs.
 *
 * Why a dedicated connection (load-bearing, not a style choice): SQLite's
 * `data_version`, as observed by a given connection, reflects ONLY commits
 * made by OTHER connections — a connection never sees its own writes as a
 * version bump. The ledger is written from two places: this server's own API
 * handlers (routes.ts, through server.ts's `db`) AND several out-of-process
 * Python worker scripts (task_telemetry.py, task_transcribe.py,
 * task_complete.py, route_task.py) that open the same ledger file directly —
 * see CLAUDE.md's "Voice pipeline"/"Telemetry rules". Reusing the server's
 * write connection here would detect only the Python-side writes and miss
 * every task created or transitioned through this API. A second, otherwise-
 * idle connection never writes anything itself, so ALL commits — from either
 * source — show up to it as "someone else changed the database".
 */

import Database from 'better-sqlite3';
import { readFileSync, statSync } from 'node:fs';

export type EventClientWriter = (chunk: string) => void;

export interface EventHub {
  /** Registers a connected SSE client; call the returned function on close. */
  addClient(write: EventClientWriter): () => void;
  /** Pings every connected client with a bare named event (default `changed`). */
  broadcast(event?: string): void;
  /** Connected-client count (diagnostics / test seam). */
  size(): number;
}

export function createEventHub(): EventHub {
  const clients = new Set<EventClientWriter>();
  return {
    addClient(write) {
      clients.add(write);
      return () => {
        clients.delete(write);
      };
    },
    broadcast(event = 'changed') {
      const chunk = `event: ${event}\ndata: {}\n\n`;
      for (const write of clients) {
        try {
          write(chunk);
        } catch {
          // A dead socket throws on write; addClient's caller (server.ts)
          // owns cleanup via its own 'close' listener — never this file's job.
        }
      }
    },
    size() {
      return clients.size;
    },
  };
}

export interface ChangeWatcher {
  stop(): void;
}

/**
 * Polls `PRAGMA data_version` on a dedicated read connection every
 * `intervalMs` (default 1 s — cheap: no table scan, an in-memory counter
 * read) and calls `onChange()` whenever it moves. Never writes through this
 * connection — see the module doc for why that separation is load-bearing.
 */
export function startChangeWatcher(
  dbPath: string,
  onChange: () => void,
  intervalMs = 1000
): ChangeWatcher {
  const conn = new Database(dbPath, { fileMustExist: true });
  const readVersion = (): number => conn.pragma('data_version', { simple: true }) as number;

  let last: number;
  try {
    last = readVersion();
  } catch {
    last = -1; // first successful poll below will detect the "change" and sync
  }

  const timer = setInterval(() => {
    let current: number;
    try {
      current = readVersion();
    } catch {
      return; // transient (e.g. a concurrent checkpoint) — retry next tick
    }
    if (current !== last) {
      last = current;
      onChange();
    }
  }, intervalMs);
  timer.unref(); // a watcher never keeps the process alive on its own

  return {
    stop() {
      clearInterval(timer);
      try {
        conn.close();
      } catch {
        // already closed
      }
    },
  };
}

export interface ShellWatcher {
  stop(): void;
}

/**
 * Polls a shell file's mtime (default: `public/sw.js`, whose hand-bumped
 * `SHELL_CACHE` constant is this project's existing "the shell changed"
 * signal — see that file's own header comment) every `intervalMs` (default
 * 5 s) and calls `onChange()` whenever it moves. A plain `statSync` is
 * enough: no content diffing, no version-string parsing — any edit to the
 * file is by definition a shell change worth telling clients to reload for,
 * and a no-op touch is harmless (worst case one extra reload).
 */
export function startShellWatcher(
  filePath: string,
  onChange: () => void,
  intervalMs = 5000
): ShellWatcher {
  const readMtime = (): number => statSync(filePath).mtimeMs;

  let last: number;
  try {
    last = readMtime();
  } catch {
    last = -1; // first successful poll below will detect the "change" and sync
  }

  const timer = setInterval(() => {
    let current: number;
    try {
      current = readMtime();
    } catch {
      return; // transient (e.g. mid-write) — retry next tick
    }
    if (current !== last) {
      last = current;
      onChange();
    }
  }, intervalMs);
  timer.unref(); // a watcher never keeps the process alive on its own

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export interface ShellVersionReader {
  /** The current shell version (e.g. 'v55'), or null when sw.js is
   *  unreadable or carries no parseable SHELL_CACHE — callers treat null
   *  as "do not nudge", never as "nudge everyone". */
  current(): string | null;
}

const SHELL_CACHE_PATTERN = /SHELL_CACHE\s*=\s*'voice-inbox-shell-(v\d+)'/;

/**
 * Reads (mtime-cached) the shell version from the SAME file the shell
 * watcher polls: the hand-bumped `SHELL_CACHE` constant in public/sw.js.
 * The stream handler compares a connecting client's declared `shell` query
 * param against this and replays a `reload` when they differ
 * (vi-7790f35108f8): the mtime-watch broadcast only reaches clients
 * connected at the moment the file changed — a page booted from a stale
 * service-worker cache that connects later never hears it, and renders any
 * newly shipped input-request kind as an unsupported-type error card until
 * it reloads.
 */
export function createShellVersionReader(filePath: string): ShellVersionReader {
  let cachedAt = -1;
  let cached: string | null = null;
  return {
    current() {
      let mtime: number;
      try {
        mtime = statSync(filePath).mtimeMs;
      } catch {
        return null;
      }
      if (mtime !== cachedAt) {
        cachedAt = mtime;
        cached = null;
        try {
          const match = readFileSync(filePath, 'utf8').match(SHELL_CACHE_PATTERN);
          if (match) cached = match[1];
        } catch {
          cached = null;
        }
      }
      return cached;
    },
  };
}

export interface ShellNudge {
  /** True exactly once per (session, on-disk version) when the session's
   *  declared shell is stale or absent — the caller sends that client a
   *  `reload` event. Current-version clients and unreadable shells never
   *  nudge, and a session never nudge-loops: the second call at the same
   *  version returns false. */
  shouldNudge(sessionKey: string, clientShell: string | null): boolean;
}

/**
 * The replay policy for missed `reload` broadcasts (vi-7790f35108f8).
 * Per-process memory: a server restart re-arms every session at the then-
 * current version — worst case one extra reload per restart for a genuinely
 * stale client, which is the desired nudge anyway. Unversioned clients
 * (shells older than the handshake itself) declare null and are nudged once
 * per version; their updateAndReload's 3 s fallback reloads them even when
 * the service worker is already current.
 */
export function createShellNudge(reader: ShellVersionReader): ShellNudge {
  const nudged = new Map<string, string>();
  return {
    shouldNudge(sessionKey, clientShell) {
      const current = reader.current();
      if (current === null || clientShell === current) return false;
      if (nudged.get(sessionKey) === current) return false;
      nudged.set(sessionKey, current);
      return true;
    },
  };
}
