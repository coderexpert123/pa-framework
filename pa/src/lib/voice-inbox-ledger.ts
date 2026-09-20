/**
 * Read-only accessor for the voice-inbox ledger (~/.pa/voice-inbox/ledger.sqlite),
 * for cross-process consumers — specifically the telegram bot's orphan reaper,
 * which has no better-sqlite3 dependency of its own and imports this module
 * from the compiled pa/dist output (the same shape as its existing pa/dist
 * imports: log.js, paths.js, worker-pids.js).
 *
 * This is a READ-ONLY, FAIL-OPEN lookup. The bot must never write into the
 * voice-inbox database, and a lookup failure (missing file, open failure,
 * missing schema, any thrown error) must never suppress the bot's own
 * recovery behavior — it returns an empty set and logs at most one warning.
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { paHome } from '../paths.js';
import { logger } from './log.js';

/** Terminal voice-inbox task states: once reached, a task never resumes. */
export const VOICE_INBOX_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'cancelled',
  'transcribe_failed',
]);

const VALID_TASK_ID_RE = /^vi-[0-9a-f]{12}$/;

// SQLite's default parameter limit is 999; chunking at 400 leaves headroom
// for any future parameters in the same statement.
const ID_CHUNK_SIZE = 400;

export function voiceInboxLedgerPath(): string {
  return join(paHome(), 'voice-inbox', 'ledger.sqlite');
}

/**
 * Of the given task ids, return the subset that are in a terminal state in
 * the voice-inbox ledger. Ids not matching the vi-<12 hex> shape are dropped
 * before ever reaching sqlite. Any failure (empty input, missing file, open
 * failure, missing `tasks` table, or any other thrown error) returns an
 * empty set rather than throwing — fail-open, because a sqlite hiccup here
 * must never suppress an unrelated dispatch's recovery.
 */
export function voiceInboxTerminalTaskIds(taskIds: readonly string[]): Set<string> {
  const validIds = taskIds.filter((id) => VALID_TASK_ID_RE.test(id));
  if (validIds.length === 0) return new Set();

  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');

    const terminal = new Set<string>();
    for (let i = 0; i < validIds.length; i += ID_CHUNK_SIZE) {
      const chunk = validIds.slice(i, i + ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT task_id, state FROM tasks WHERE task_id IN (${placeholders})`)
        .all(...chunk) as Array<{ task_id: string; state: string }>;
      for (const row of rows) {
        if (VOICE_INBOX_TERMINAL_STATES.has(row.state)) {
          terminal.add(row.task_id);
        }
      }
    }
    return terminal;
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read voice-inbox ledger; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/** One carried task's routing-relevant state, read read-only from the
 *  voice-inbox ledger. `routedTo` is the `<chatId>_<threadId>` topic key the
 *  task was routed into (the same key shape the bot's thread stores use), or
 *  null when no destination was ever recorded. */
export interface VoiceInboxTaskState {
  state: string;
  routedTo: string | null;
}

/**
 * State + routed_to for the given task ids. Ids not matching the vi-<12 hex>
 * shape are dropped before ever reaching sqlite; ids the ledger does not know
 * are ABSENT from the map (never null-valued). Read-only, fail-open: any
 * failure (empty input, missing file, open failure, missing schema, any
 * thrown error) returns an empty map plus at most one warn — a sqlite hiccup
 * here must never suppress a caller's own recovery.
 */
export function voiceInboxTaskStates(taskIds: readonly string[]): Map<string, VoiceInboxTaskState> {
  const validIds = taskIds.filter((id) => VALID_TASK_ID_RE.test(id));
  if (validIds.length === 0) return new Map();

  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');

    const states = new Map<string, VoiceInboxTaskState>();
    for (let i = 0; i < validIds.length; i += ID_CHUNK_SIZE) {
      const chunk = validIds.slice(i, i + ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT task_id, state, routed_to FROM tasks WHERE task_id IN (${placeholders})`)
        .all(...chunk) as Array<{ task_id: string; state: string; routed_to: string | null }>;
      for (const row of rows) states.set(row.task_id, { state: row.state, routedTo: row.routed_to });
    }
    return states;
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read voice-inbox task states; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/** One task's request as the operator gave it, read read-only from the
 *  voice-inbox ledger for the bot's turn-routing classifier. `requestText` is
 *  tasks.request_text: the typed text, or for a voice task the transcript once
 *  transcription lands (a placeholder before that), possibly rewritten by
 *  task_request.py clean. `transcript` is the immutable raw transcript — null
 *  for text tasks and for voice tasks not yet transcribed. */
export interface VoiceInboxTaskRequest {
  source: string;
  requestText: string;
  transcript: string | null;
}

/**
 * The operator's words for one ledger row, or undefined when the row has none
 * yet. A voice task with no transcript is not transcribed — its request_text is
 * still a placeholder. request_text wins over transcript: it is what the worker
 * is told, and after task_request.py clean it is the operator's words minus
 * filler. The bot's turn-routing classifier and `pa typesafe eval --judge` both
 * read ledger requests through this one rule.
 */
export function classifiableRequestText(row: VoiceInboxTaskRequest): string | undefined {
  const request = (row.requestText ?? '').trim();
  if (row.source === 'voice') {
    const transcript = (row.transcript ?? '').trim();
    if (transcript === '') return undefined;
    return request !== '' ? request : transcript;
  }
  return request !== '' ? request : undefined;
}

/**
 * Source, request_text and transcript for the given task ids. Same contract as
 * voiceInboxTaskStates: ids not matching the vi-<12 hex> shape are dropped
 * before ever reaching sqlite; ids the ledger does not know are ABSENT from the
 * map. Read-only, fail-open: any failure returns an empty map plus at most one
 * warn — a routing classification must never fail because the ledger did.
 */
export function voiceInboxTaskRequests(taskIds: readonly string[]): Map<string, VoiceInboxTaskRequest> {
  const validIds = taskIds.filter((id) => VALID_TASK_ID_RE.test(id));
  if (validIds.length === 0) return new Map();

  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');

    const requests = new Map<string, VoiceInboxTaskRequest>();
    for (let i = 0; i < validIds.length; i += ID_CHUNK_SIZE) {
      const chunk = validIds.slice(i, i + ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT task_id, source, request_text, transcript FROM tasks WHERE task_id IN (${placeholders})`)
        .all(...chunk) as Array<{ task_id: string; source: string; request_text: string | null; transcript: string | null }>;
      for (const row of rows) {
        requests.set(row.task_id, { source: row.source, requestText: row.request_text ?? '', transcript: row.transcript });
      }
    }
    return requests;
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read voice-inbox task requests; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/** One conversation's steer-relevant state, read read-only from the
 * voice-inbox ledger (WP-5 D4). `workerResource` / `workerDispatchId` /
 * `originTaskId` come from the NEWEST task in the conversation that carries a
 * worker resource, whatever that task's state — a finished conversation is
 * still steerable through its thread record. `taskIds` is every task in the
 * conversation, newest first, capped at 50; the drain uses it to recognise a
 * sibling route-queue line. NOT tenant-scoped: the bot has no tenant, and a
 * conversation id is a `vi-<12 hex>` id unique across the ledger.
 * Fails open in every failure mode (missing file, missing table, any throw):
 * an empty state makes the drain HOLD the steer entry and retry, which is the
 * safe direction — it never causes a steer to be dropped or downgraded. */
export interface VoiceInboxConversationState {
  workerResource: string | null;
  workerDispatchId: string | null;
  originTaskId: string | null;
  taskIds: string[];
}

const EMPTY_CONVERSATION_STATE: VoiceInboxConversationState = {
  workerResource: null,
  workerDispatchId: null,
  originTaskId: null,
  taskIds: [],
};

/** One answered `secret`-kind input request, read read-only from the
 * voice-inbox ledger (auth broker Phase A, D5 second clause, 2026-09-10).
 * `answer_pointer` is a path under `~/.pa/voice-inbox/answers/`; the row
 * itself never carries the answered value. */
export interface AnsweredSecretRow {
  request_id: string;
  task_id: string;
  answer_pointer: string | null;
  answered_at: string | null;
}

/**
 * Answered `secret`-kind input requests with `answered_at` at or before
 * `answeredBefore` (ISO), across every tenant. This is the reaper's second
 * retention scope (D5): it covers worker-created secret widgets that never
 * grew a broker row under `~/.pa/auth/requests/`, which the broker's own
 * `delivered_at`-driven pass cannot see at all.
 * Read-only, fail-open: a missing file, missing schema, or any thrown error
 * returns an empty array plus one warn — this reader must never suppress the
 * reaper's other retention passes.
 */
export function voiceInboxAnsweredSecretRequests(answeredBefore: string): AnsweredSecretRow[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    return db
      .prepare(
        `SELECT request_id, task_id, answer_pointer, answered_at FROM input_requests
         WHERE kind = 'secret' AND status = 'answered' AND answered_at IS NOT NULL AND answered_at <= ?`
      )
      .all(answeredBefore) as AnsweredSecretRow[];
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read answered secret requests; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/** One `running` task carrying a dispatch id, read read-only from the
 * voice-inbox ledger — a candidate for the deterministic fallback's
 * dead-dispatch replay (AI-221 extension, C4, auth broker Phase A,
 * 2026-09-10). `conversation_id` is `NOT NULL DEFAULT ''` on the `tasks`
 * table (`projects/voice-inbox/src/ledger.ts`'s `LEDGER_SCHEMA_SQL`,
 * `createTask` always sets it) — never optional, same as `StuckTaskRow`'s
 * own `conversation_id` field (E34, AI-conversation-context WP-3 follow-up,
 * closing the gap that WP-3 reported: this row type never carried the
 * column the dead-dispatch briefing path needs). */
export interface RunningDispatchRow {
  task_id: string;
  tenant_id: string;
  conversation_id: string;
  routed_to: string | null;
  request_text: string;
  worker_dispatch_id: string;
  updated_at: string;
}

/**
 * `running` tasks that carry a NON-EMPTY `worker_dispatch_id` and were last
 * updated at or before `updatedBefore` (ISO), oldest first. The
 * `worker_dispatch_id IS NOT NULL AND != ''` clause is load-bearing (C4): a
 * standing auth task (D3) is `running` between `pa auth request`'s
 * transitions with a NULL dispatch id — it was never dispatched to a worker
 * at all — and must never match this selector, or the fallback would
 * re-dispatch the broker's own standing conversation tasks.
 * Read-only, fail-open: same convention as every other reader in this module.
 */
export function voiceInboxRunningWithDispatch(updatedBefore: string): RunningDispatchRow[] {
  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    return db
      .prepare(
        `SELECT task_id, tenant_id, conversation_id, routed_to, request_text, worker_dispatch_id, updated_at FROM tasks
         WHERE state = 'running' AND worker_dispatch_id IS NOT NULL AND worker_dispatch_id != '' AND updated_at <= ?
         ORDER BY updated_at ASC`
      )
      .all(updatedBefore) as RunningDispatchRow[];
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read running dispatch tasks; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

const VALID_REQUEST_ID_RE = /^ir-[0-9a-f]{12}$/;

/**
 * The `auth_url` a worker/backend minted for one pending `oauth` input
 * request, read read-only from the voice-inbox ledger (auth broker Phase A
 * follow-up, deep-recheck 2026-09-10). The §3.3 broker row
 * (`~/.pa/auth/requests/<id>.json`, `pa/src/lib/auth/store.ts` +
 * `projects/voice-inbox/src/auth-providers.ts`) NEVER carries `auth_url` —
 * both real writers' `AuthRequestRow` interfaces omit it — the value is
 * minted into the LEDGER's `input_requests.params_json` by
 * `oauth-mint.ts`'s `mintOauthAuthUrl` (and by `pa auth request --url`'s
 * direct `params_json` UPDATE). A caller that reads the broker-row file for
 * this value always gets null in production; this is the correct reader.
 * `request_id` is the table's primary key, so no tenant scoping is needed
 * (same convention as `voiceInboxAnsweredSecretRequests`).
 * Fail-open in every failure mode (bad id shape, missing file, missing
 * schema, torn `params_json`, any thrown error): returns null, never throws.
 */
export function voiceInboxInputRequestAuthUrl(requestId: string): string | null {
  if (!VALID_REQUEST_ID_RE.test(requestId)) return null;

  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
    const row = db
      .prepare('SELECT params_json FROM input_requests WHERE request_id = ?')
      .get(requestId) as { params_json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.params_json) as { auth_url?: unknown };
    return typeof parsed.auth_url === 'string' && parsed.auth_url.startsWith('https://')
      ? parsed.auth_url
      : null;
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read input request auth_url; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

/** One conversation's placement candidacy for the model router (spec
 *  router-as-orchestrator §3.1, WP-2). All fields describe the conversation's
 *  NEWEST task row (by `updated_at DESC, task_id DESC`). `goal` is
 *  `conversation_meta.title` when one exists, else the newest task's
 *  `request_text` — the CALLER applies the 80-char goal cap (`goal_chars`,
 *  §1.2); this reader returns it uncapped. NOT tenant-scoped: a conversation
 *  id is a `vi-<12 hex>` id unique across the ledger. */
export interface PlacementCandidate {
  conversationId: string;
  goal: string;
  status: string;
  inflight: boolean;
  routedTo: string | null;
  updatedAt: string;
}

/** Task states that count as in-flight for placement purposes (§3.1). */
export const VOICE_INBOX_PLACEMENT_INFLIGHT_STATES: ReadonlySet<string> = new Set([
  'received',
  'transcribing',
  'routed',
  'running',
  'awaiting_input',
]);

/**
 * The ledger's conversations as placement candidates, newest-updated first,
 * capped. One window query takes each conversation's newest task row
 * (`ROW_NUMBER() ... ORDER BY updated_at DESC, task_id DESC` over
 * `conversation_id != ''`); `title` is folded in from `conversation_meta` in
 * a second query. NO SCHEMA CHANGE — reads existing columns only.
 *
 * Cap (§1.2): over `cap`, the newest-updated `cap` conversations are kept and
 * the rest dropped, with one warn line (counts + ids only, never goals —
 * §9.2 shadow invariants). m3 (spec-recheck 2026-09-19): the READER owns the
 * truncation exemption — when `currentConversationId` names a conversation
 * that truncation would drop, it is swapped INTO the kept set and the oldest
 * kept candidate is evicted instead, so the current conversation's own
 * candidate is never lost. An id that does not match the `vi-<12 hex>` shape
 * or names no ledger conversation is ignored.
 *
 * Manual/auto candidacy (spec §0.1 I-1) is enforced STRUCTURALLY: only
 * ledger conversations can be returned, and every ledger conversation is
 * operator-started by construction. Read-only, fail-open: any failure
 * (missing file, open failure, missing schema, any thrown error) returns an
 * empty array plus at most one warn — a placement decision must never fail
 * because the ledger did.
 */
export function voiceInboxPlacementCandidates(
  cap: number,
  currentConversationId?: string,
): PlacementCandidate[] {
  if (!Number.isFinite(cap) || cap <= 0) return [];

  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');

    const newestPerConversation = `
      SELECT conversation_id, state, routed_to, request_text, updated_at FROM (
        SELECT task_id, conversation_id, state, routed_to, request_text, updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY conversation_id ORDER BY updated_at DESC, task_id DESC
               ) AS rn
        FROM tasks
        WHERE conversation_id != ''`
    const newestCols =
      ' ) WHERE rn = 1 ORDER BY updated_at DESC';

    const kept = db
      .prepare(`${newestPerConversation}${newestCols} LIMIT ?`)
      .all(cap) as Array<{
      conversation_id: string;
      state: string | null;
      routed_to: string | null;
      request_text: string | null;
      updated_at: string | null;
    }>;

    const total = (
      db
        .prepare(`SELECT COUNT(DISTINCT conversation_id) AS n FROM tasks WHERE conversation_id != ''`)
        .get() as { n: number }
    ).n;

    if (total > kept.length) {
      // m3: the current conversation's own candidate is never dropped by
      // truncation — swap it into the kept set, evict the oldest kept.
      const keepId =
        typeof currentConversationId === 'string' && VALID_TASK_ID_RE.test(currentConversationId)
          ? currentConversationId
          : undefined;
      if (keepId && !kept.some((r) => r.conversation_id === keepId)) {
        const own = db
          .prepare(`${newestPerConversation} AND conversation_id = ?${newestCols}`)
          .get(keepId) as
          | { conversation_id: string; state: string | null; routed_to: string | null; request_text: string | null; updated_at: string | null }
          | undefined;
        if (own) {
          kept.pop();
          kept.push(own);
          // Restore newest-updated-first order (stable sort keeps the SQL
          // order for equal updated_at values).
          kept.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
        }
      }
      logger.warn('voice-inbox-ledger', 'placement candidates truncated at cap', {
        cap,
        total,
        dropped: total - kept.length,
        ids: kept.map((r) => r.conversation_id),
      });
    }

    const titles = new Map<string, string>();
    const ids = kept.map((r) => r.conversation_id);
    for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT conversation_id, title FROM conversation_meta WHERE conversation_id IN (${placeholders})`)
        .all(...chunk) as Array<{ conversation_id: string; title: string | null }>;
      for (const row of rows) {
        if (typeof row.title === 'string' && row.title !== '') titles.set(row.conversation_id, row.title);
      }
    }

    return kept.map((r) => ({
      conversationId: r.conversation_id,
      goal: titles.get(r.conversation_id) ?? (r.request_text ?? ''),
      status: r.state ?? '',
      inflight: VOICE_INBOX_PLACEMENT_INFLIGHT_STATES.has(r.state ?? ''),
      routedTo: r.routed_to ?? null,
      updatedAt: r.updated_at ?? '',
    }));
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read placement candidates; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}

export function voiceInboxConversationState(conversationId: string): VoiceInboxConversationState {
  if (!VALID_TASK_ID_RE.test(conversationId)) return EMPTY_CONVERSATION_STATE;

  let db: Database.Database | undefined;
  try {
    db = new Database(voiceInboxLedgerPath(), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');

    const resourceRow = db
      .prepare(
        `SELECT task_id, worker_resource, worker_dispatch_id FROM tasks
         WHERE conversation_id = ? AND worker_resource IS NOT NULL AND worker_resource != ''
         ORDER BY updated_at DESC, task_id DESC LIMIT 1`
      )
      .get(conversationId) as
      | { task_id: string; worker_resource: string; worker_dispatch_id: string | null }
      | undefined;

    const idRows = db
      .prepare(
        `SELECT task_id FROM tasks WHERE conversation_id = ?
         ORDER BY created_at DESC, task_id DESC LIMIT 50`
      )
      .all(conversationId) as Array<{ task_id: string }>;

    return {
      workerResource: resourceRow?.worker_resource ?? null,
      workerDispatchId: resourceRow?.worker_dispatch_id ?? null,
      originTaskId: resourceRow?.task_id ?? null,
      taskIds: idRows.map((r) => r.task_id),
    };
  } catch (err) {
    logger.warn('voice-inbox-ledger', 'failed to read voice-inbox conversation state; failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return EMPTY_CONVERSATION_STATE;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never successfully opened */
    }
  }
}
