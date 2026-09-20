/**
 * Turn-context reader for the model router (wave 2026-09-18, WP-C).
 *
 * Reads prior conversation turns from one of two stores so the router's
 * needs classifier sees a bounded digest of recent context:
 *   - 'telegram':    ~/.pa/conversation-history.jsonl, filtered by
 *                    `turn.thread_id` ONLY — chat_id is not stored in archive
 *                    turns (projects/telegram-bot/src/conversation.ts), and the
 *                    topic-scoped, single-user precedent documented there makes
 *                    thread_id alone sufficient. The same single stream also
 *                    captures the incumbent worker (the `worker` field on the
 *                    newest matching line) for conversation stickiness.
 *   - 'voice-inbox': ~/.pa/voice-inbox/ledger.sqlite, `tasks` rows selected by
 *                    `conversation_id` (schema v14: NOT NULL DEFAULT '').
 *
 * READ-ONLY invariant: this module never writes either store — the sqlite
 * handle opens with `readonly: true, fileMustExist: true` (busy_timeout 3000,
 * closed in `finally`), mirroring voice-inbox-ledger.ts, and the JSONL store is
 * read through a plain file descriptor. FAIL-OPEN invariant: this function
 * NEVER throws — any failure (missing file, open failure, missing schema,
 * malformed JSON, any throw) returns undefined; a context hiccup must never
 * suppress a routing decision.
 *
 * The JSONL store is STREAMED (fixed-size chunks through a file descriptor),
 * never loaded whole — the archive is append-only and grows without bound.
 * Matches are retained in a bounded deque (the digest cap bounds how many
 * turns can ever survive), so memory stays flat regardless of file size.
 */

import { openSync, readSync, closeSync, fstatSync, type Stats } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { paHome } from '../../paths.js';
import { logger } from '../log.js';

export interface PriorTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface TurnContext {
  priorTurns: PriorTurn[];
  /** Conversation stickiness (intent decision 19): the worker that served the
   *  most recent turn. Telegram store: the `worker` field on the newest
   *  archive turn for this thread (last non-empty wins). Voice-inbox store:
   *  the newest non-empty `tasks.worker_cli` (schema v15) across the
   *  conversation's rows (spec correction 1; the ledger DID grow a serving
   *  worker column on 2026-09-18 — the old "always undefined there" claim was
   *  stale). */
  incumbentWorker?: string;
}

export type ContextStore = 'telegram' | 'voice-inbox';

/** Dependencies seam — the ONLY route to stub external I/O in tests. */
export interface ContextReaderDeps {
  telegramPath?: () => string;
  openSqlite?: (p: string) => Database.Database;
}

/** Per-turn text budget: each surviving turn's text is truncated to this. */
const PER_TURN_TEXT_CHARS = 400;

/** Bounded deque size while streaming: the digest cap (context_max_chars,
 *  default 2000) can keep at most ~5-6 turns of 400 chars each, so 64 covers
 *  every reachable outcome with headroom while keeping memory flat. */
const STREAM_MATCH_RETENTION = 64;

/** One turn's raw shape in conversation-history.jsonl (subset we read).
 *  Archive turns carry `timestamp` (role,text,timestamp,message_id,worker,
 *  session_id,thread_id); `at` is accepted as a legacy alias. */
interface ArchiveTurn {
  role?: unknown;
  text?: unknown;
  timestamp?: unknown;
  at?: unknown;
  thread_id?: unknown;
  worker?: unknown;
}

function voiceInboxLedgerPath(): string {
  return join(paHome(), 'voice-inbox', 'ledger.sqlite');
}

function archivePath(): string {
  return join(paHome(), 'conversation-history.jsonl');
}

/** True when the turn is a usable user/assistant turn with text content. */
function isPriorTurnRole(role: unknown): role is 'user' | 'assistant' {
  return role === 'user' || role === 'assistant';
}

/** Truncate one turn's text to the per-turn budget. */
function clampText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  return text.length <= PER_TURN_TEXT_CHARS ? text : text.slice(0, PER_TURN_TEXT_CHARS);
}

/** Cap the digest: newest-first turns; drop oldest-first until the total
 *  character budget fits, always keeping at least one turn (itself clamped
 *  to the budget if it alone exceeds it). */
function capDigest(turns: PriorTurn[], contextMaxChars: number): PriorTurn[] {
  const kept = turns.slice();
  const totalChars = () => kept.reduce((sum, t) => sum + t.text.length, 0);
  while (kept.length > 1 && totalChars() > contextMaxChars) kept.pop();
  if (kept.length === 1 && kept[0].text.length > contextMaxChars) {
    kept[0] = { ...kept[0], text: kept[0].text.slice(0, Math.max(0, contextMaxChars)) };
  }
  return kept;
}

/** Tail-stream the archive, returning the LAST `retention` matching turns in
 *  file order (oldest → newest) plus the incumbent worker (the `worker` field
 *  on the newest matching line that carries one — lines are chronological, so
 *  the last match wins; never break early). Streams fixed-size chunks through
 *  a file descriptor; never loads the whole file. Malformed lines are skipped. */
function streamMatchingTurns(
  path: string,
  threadId: number,
  retention: number,
): { turns: PriorTurn[]; incumbentWorker?: string } {
  let fd: number | undefined;
  try {
    let stats: Stats;
    // Missing archive propagates to the caller's fail-open (undefined),
    // matching the voice-inbox side where fileMustExist throws on absence.
    stats = fstatSync(fd = openSync(path, 'r'));
    if (stats.size === 0) return { turns: [] };

    const buf = Buffer.alloc(64 * 1024);
    const deque: PriorTurn[] = [];
    let incumbentWorker: string | undefined;
    let carry = '';
    let bytesLeft = stats.size;
    while (bytesLeft > 0) {
      const toRead = Math.min(buf.length, bytesLeft);
      const bytesRead = readSync(fd, buf, 0, toRead, stats.size - bytesLeft);
      if (bytesRead <= 0) break;
      bytesLeft -= bytesRead;
      carry += buf.toString('utf8', 0, bytesRead);
      let nl: number;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl).replace(/\r$/, '');
        carry = carry.slice(nl + 1);
        const w = applyArchiveLine(line, threadId, deque, retention);
        if (w !== undefined) incumbentWorker = w;
      }
    }
    // Final unterminated line, if any.
    if (carry.trim() !== '') {
      const w = applyArchiveLine(carry, threadId, deque, retention);
      if (w !== undefined) incumbentWorker = w;
    }
    // File order is oldest → newest; the contract is newest-first.
    return { turns: deque.reverse(), incumbentWorker };
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/** Parse one archive line and, when it matches the thread, push it onto the
 *  bounded deque (oldest at index 0; oldest dropped past `retention`).
 *  Returns the line's non-empty `worker` field when present — the caller
 *  keeps the LAST such value as the incumbent. */
function applyArchiveLine(
  line: string,
  threadId: number,
  deque: PriorTurn[],
  retention: number,
): string | undefined {
  try {
    const turn = JSON.parse(line) as ArchiveTurn;
    if (turn.thread_id !== threadId) return undefined;
    if (isPriorTurnRole(turn.role)) {
      const at = typeof turn.timestamp === 'string' ? turn.timestamp : typeof turn.at === 'string' ? turn.at : '';
      deque.push({ role: turn.role, text: clampText(turn.text), at });
      if (deque.length > retention) deque.shift();
    }
    // The incumbent is read from ANY matching line carrying a non-empty
    // worker field (assistant dispatch rows record which worker served) —
    // independent of whether the line counted as a prior turn.
    return typeof turn.worker === 'string' && turn.worker !== '' ? turn.worker : undefined;
  } catch {
    /* malformed line — skip, same convention as the archive lookups */
    return undefined;
  }
}

/** Read-only sqlite read of one conversation's recent task requests plus the
 *  v15 incumbent (correction 1): the NEWEST non-empty `worker_cli` — the
 *  first carrying row in the SQL's newest-first order; rows without a
 *  worker_cli do not clear it (same last-non-empty-wins semantics as the
 *  telegram path's `worker` field). */
function readVoiceInboxTurns(
  conversationId: string,
  openSqlite: (p: string) => Database.Database,
): { turns: PriorTurn[]; incumbentWorker?: string } {
  let db: Database.Database | undefined;
  try {
    db = openSqlite(voiceInboxLedgerPath());
    db.pragma('busy_timeout = 3000');
    const rows = db
      .prepare(
        `SELECT request_text, created_at, worker_cli FROM tasks
         WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(conversationId) as Array<{ request_text: string | null; created_at: string | null; worker_cli: string | null }>;
    // SQL already orders newest-first; per-turn budget + digest cap below.
    const turns = rows.map((row) => ({
        role: 'user' as const,
        text: clampText(row.request_text),
        at: typeof row.created_at === 'string' ? row.created_at : '',
    }));
    const incumbentWorker = rows
      .map((row) => (typeof row.worker_cli === 'string' && row.worker_cli !== '' ? row.worker_cli : undefined))
      .find((w) => w !== undefined);
    return { turns, incumbentWorker };
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/**
 * Resolve a voice-inbox conversation_id from the task ids a turn named —
 * `readTurnContext('voice-inbox', key)` keys on conversation_id
 * ('vi-<12 hex>'), never on a Telegram topicKey, so a turn that names
 * ledger tasks needs this translation before its context can be read.
 * First task id (first-seen order) with a non-empty conversation_id wins.
 * Same READ-ONLY contract as the rest of this module: readonly +
 * fileMustExist + busy_timeout 3000, closed in `finally`. NEVER throws —
 * any failure returns undefined and the caller keeps its topicKey fallback.
 */
export function voiceConversationKeyForTasks(
  taskIds: readonly string[],
  deps?: ContextReaderDeps,
): string | undefined {
  try {
    // Same pre-sqlite id filter + IN-chunking as voice-inbox-ledger.ts's
    // readers (VALID_TASK_ID_RE /^vi-[0-9a-f]{12}$/, 400-row chunks).
    const validIds = taskIds.filter((id) => /^vi-[0-9a-f]{12}$/.test(id));
    if (validIds.length === 0) return undefined;
    const openSqlite = deps?.openSqlite ?? ((p: string) => new Database(p, { readonly: true, fileMustExist: true }));
    let db: Database.Database | undefined;
    try {
      db = openSqlite(voiceInboxLedgerPath());
      db.pragma('busy_timeout = 3000');
      const byTask = new Map<string, string | null>();
      for (let i = 0; i < validIds.length; i += 400) {
        const chunk = validIds.slice(i, i + 400);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT task_id, conversation_id FROM tasks WHERE task_id IN (${placeholders})`)
          .all(...chunk) as Array<{ task_id: string; conversation_id: string | null }>;
        for (const row of rows) byTask.set(row.task_id, row.conversation_id);
      }
      for (const id of validIds) {
        const conv = byTask.get(id);
        if (typeof conv === 'string' && conv !== '') return conv;
      }
      return undefined;
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed or never successfully opened */
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * Read the prior turns for one store key. `key` is the threadId (numeric
 * string) for 'telegram' and the conversation_id for 'voice-inbox'.
 * Newest-first, oldest dropped first, whole digest capped to
 * `caps.context_max_chars`. NEVER throws; any failure returns undefined.
 * READ-ONLY against both stores.
 */
export function readTurnContext(
  store: ContextStore,
  key: string,
  caps: { context_max_chars: number },
  deps?: ContextReaderDeps,
): TurnContext | undefined {
  try {
    const contextMaxChars =
      Number.isFinite(caps?.context_max_chars) && caps.context_max_chars > 0
        ? caps.context_max_chars
        : 2000;

    let turns: PriorTurn[];
    let incumbentWorker: string | undefined;
    if (store === 'telegram') {
      const threadId = Number(key);
      if (!Number.isInteger(threadId)) {
        logger.warn('model-router/context-reader', 'non-numeric telegram thread key; failing open', { key });
        return undefined;
      }
      const streamed = streamMatchingTurns(deps?.telegramPath?.() ?? archivePath(), threadId, STREAM_MATCH_RETENTION);
      turns = streamed.turns;
      incumbentWorker = streamed.incumbentWorker;
    } else {
      const read = readVoiceInboxTurns(key, deps?.openSqlite ?? ((p) => new Database(p, { readonly: true, fileMustExist: true })));
      turns = read.turns;
      incumbentWorker = read.incumbentWorker;
    }

    turns = capDigest(turns, contextMaxChars);
    const ctx: TurnContext = { priorTurns: turns };
    if (incumbentWorker !== undefined) ctx.incumbentWorker = incumbentWorker;
    return ctx;
  } catch (err) {
    logger.warn('model-router/context-reader', 'failed to read turn context; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
