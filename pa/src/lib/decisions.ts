/**
 * Decision traces helper (AI-164) — TypeScript twin.
 *
 * Records judgment calls (request, decision, rationale, alternatives) with
 * outcome (approved/rejected by reaction, replied by next turn) and reaction.
 * Rows are immutable after insert except outcome/reaction/message fills.
 *
 * Every function opens, runs one transaction, closes in finally, and NEVER
 * throws — a decision-row write must never break a dispatch or a button press.
 * Failures log and return {ok:false, error}.
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { paHome } from '../paths.js';
import { logger } from './log.js';
import { redactSecrets } from './redact.js';

export const DECISIONS_SCHEMA_SQL = `PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS decisions (
  decision_id     TEXT PRIMARY KEY,
  refId           TEXT,
  session_id      TEXT,
  thread_id       INTEGER,
  source          TEXT NOT NULL CHECK (source IN ('skill','bot')),
  skill           TEXT,
  request_excerpt TEXT NOT NULL,
  context_refs    TEXT,
  decision        TEXT NOT NULL,
  rationale       TEXT NOT NULL,
  alternatives    TEXT,
  outcome         TEXT,
  reaction        TEXT,
  chat_id         INTEGER,
  message_id      INTEGER,
  ts              TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(decision_id UNINDEXED, request_excerpt, decision, rationale);
CREATE INDEX IF NOT EXISTS decisions_thread_ts ON decisions(thread_id, ts);
CREATE INDEX IF NOT EXISTS decisions_chat_msg  ON decisions(chat_id, message_id);
`;

export interface DecisionRowInput {
  source: 'skill' | 'bot';
  skill?: string;
  request_excerpt: string;
  decision: string;
  rationale: string;
  alternatives?: string[];
  context_refs?: string[];
  refId?: string;
  session_id?: string;
  thread_id?: number;
  chat_id?: number;
  message_id?: number;
  outcome?: string;
  reaction?: string;
}

export interface DecisionWriteResult {
  ok: boolean;
  decisionId?: string;
  matched?: number;
  error?: string;
}

function decisionsDbPath(): string {
  return `${paHome()}/decisions.sqlite`;
}

/**
 * Open the decisions database with proper pragmas.
 * Creates the DB and schema if it doesn't exist.
 */
function openDecisions(): Database.Database {
  const dbPath = decisionsDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 3000');
  db.pragma('journal_mode = WAL');
  db.exec(DECISIONS_SCHEMA_SQL);
  return db;
}

/**
 * Generate a decision ID: d-<YYYYMMDDHHMM>-<12 lowercase hex>
 */
function generateDecisionId(): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const hex = randomBytes(6).toString('hex');
  return `d-${ts}-${hex}`;
}

/**
 * Current UTC timestamp in ISO-8601 with millisecond precision and Z suffix.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Apply caps to decision row fields per §2.2.
 */
function applyCaps(row: DecisionRowInput): DecisionRowInput {
  return {
    ...row,
    request_excerpt: row.request_excerpt.slice(0, 200),
    decision: row.decision.slice(0, 500),
    rationale: row.rationale.slice(0, 1000),
    alternatives: row.alternatives?.slice(0, 8).map(a => a.slice(0, 200)),
    context_refs: row.context_refs?.slice(0, 8).map(r => r.slice(0, 200)),
  };
}

/**
 * Redact secrets from decision fields per §2.4.
 */
function redactRow(row: DecisionRowInput): DecisionRowInput {
  const redacted = { ...row };
  redacted.request_excerpt = redactSecrets(row.request_excerpt) as string;
  redacted.decision = redactSecrets(row.decision) as string;
  redacted.rationale = redactSecrets(row.rationale) as string;
  if (redacted.alternatives) {
    redacted.alternatives = redacted.alternatives.map(a => redactSecrets(a) as string);
  }
  if (redacted.context_refs) {
    redacted.context_refs = redacted.context_refs.map(r => redactSecrets(r) as string);
  }
  return redacted;
}

/**
 * Record a new decision row.
 *
 * Applies caps, redacts secrets, mints decision_id/ts/updated_at, and inserts
 * both the decisions row and the FTS row in one transaction.
 *
 * Returns {ok:true, decisionId} on success, {ok:false, error} on failure.
 */
export function recordDecision(row: DecisionRowInput): DecisionWriteResult {
  try {
    // Validate and prepare
    if (row.source !== 'skill' && row.source !== 'bot') {
      return { ok: false, error: 'invalid row: source must be skill or bot' };
    }

    const capped = applyCaps(row);
    const redacted = redactRow(capped);

    if (!redacted.request_excerpt.trim() || !redacted.decision.trim() || !redacted.rationale.trim()) {
      return { ok: false, error: 'invalid row: request_excerpt, decision, and rationale are required' };
    }

    const decisionId = generateDecisionId();
    const ts = nowIso();

    const db = openDecisions();
    try {
      const insertRow = db.transaction(() => {
        const stmt = db.prepare(`
          INSERT INTO decisions (
            decision_id, refId, session_id, thread_id, source, skill,
            request_excerpt, context_refs, decision, rationale, alternatives,
            outcome, reaction, chat_id, message_id, ts, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          decisionId,
          redacted.refId ?? null,
          redacted.session_id ?? null,
          redacted.thread_id ?? null,
          redacted.source,
          redacted.skill ?? null,
          redacted.request_excerpt,
          redacted.context_refs ? JSON.stringify(redacted.context_refs) : null,
          redacted.decision,
          redacted.rationale,
          redacted.alternatives ? JSON.stringify(redacted.alternatives) : null,
          redacted.outcome ?? null,
          redacted.reaction ?? null,
          redacted.chat_id ?? null,
          redacted.message_id ?? null,
          ts,
          ts
        );

        const ftsStmt = db.prepare(`
          INSERT INTO decisions_fts (decision_id, request_excerpt, decision, rationale)
          VALUES (?, ?, ?, ?)
        `);
        ftsStmt.run(decisionId, redacted.request_excerpt, redacted.decision, redacted.rationale);
      })();

      return { ok: true, decisionId };
    } finally {
      db.close();
    }
  } catch (err: any) {
    const error = err?.message ?? String(err);
    logger.warn('decisions', 'recordDecision failed', { error });
    return { ok: false, error };
  }
}

/**
 * Attach a decision row to a Telegram message.
 *
 * Updates chat_id and message_id for a row that currently has NULL values.
 * A row already attached to a message is never re-pointed.
 *
 * Returns {ok:true, matched:1} on success, {ok:true, matched:0} if already attached,
 * {ok:false, error} on failure.
 */
export function attachDecisionMessage(
  decisionId: string,
  chatId: number,
  messageId: number
): DecisionWriteResult {
  try {
    const db = openDecisions();
    try {
      const stmt = db.prepare(`
        UPDATE decisions
        SET chat_id = ?, message_id = ?, updated_at = ?
        WHERE decision_id = ? AND chat_id IS NULL AND message_id IS NULL
      `);
      const now = nowIso();
      const result = stmt.run(chatId, messageId, now, decisionId);
      return { ok: true, matched: result.changes };
    } finally {
      db.close();
    }
  } catch (err: any) {
    const error = err?.message ?? String(err);
    logger.warn('decisions', 'attachDecisionMessage failed', { decisionId, error });
    return { ok: false, error };
  }
}

/**
 * Record a reaction to decision rows attached to a message.
 *
 * Updates EVERY row matching (chat_id, message_id). A brief message can
 * legitimately carry several rows and one 👍 applies to the batch.
 *
 * Sets reaction, updated_at, and outcome for 👍/👎. Other emojis fill reaction only.
 *
 * Returns {ok:true, matched: N} where N is rows updated, or {ok:false, error}.
 */
export function recordReaction(
  chatId: number,
  messageId: number,
  reaction: string
): DecisionWriteResult {
  try {
    const db = openDecisions();
    try {
      const now = nowIso();

      let result: Database.RunResult;
      if (reaction === '👍') {
        const stmt = db.prepare(`
          UPDATE decisions
          SET reaction = ?, updated_at = ?, outcome = 'approved'
          WHERE chat_id = ? AND message_id = ?
        `);
        result = stmt.run(reaction, now, chatId, messageId);
      } else if (reaction === '👎') {
        const stmt = db.prepare(`
          UPDATE decisions
          SET reaction = ?, updated_at = ?, outcome = 'rejected'
          WHERE chat_id = ? AND message_id = ?
        `);
        result = stmt.run(reaction, now, chatId, messageId);
      } else {
        // Non-approval emoji: fill reaction only, leave outcome untouched
        const stmt = db.prepare(`
          UPDATE decisions
          SET reaction = ?, updated_at = ?
          WHERE chat_id = ? AND message_id = ?
        `);
        result = stmt.run(reaction, now, chatId, messageId);
      }

      return { ok: true, matched: result.changes };
    } finally {
      db.close();
    }
  } catch (err: any) {
    const error = err?.message ?? String(err);
    logger.warn('decisions', 'recordReaction failed', { chatId, messageId, error });
    return { ok: false, error };
  }
}

/**
 * Mark decisions in a thread as 'replied' (weak signal).
 *
 * Fills outcome='replied' for NULL-outcome rows in the thread within 24h.
 * The reaction IS NULL guard keeps a filled reaction (strong) from ever being
 * downgraded to 'replied' (weak).
 *
 * @param chatId - Chat ID
 * @param threadId - Thread ID
 * @param nowMs - Current time in ms (for testing; defaults to Date.now())
 * @returns {ok:true, matched: N} or {ok:false, error}
 */
export function markRepliedForThread(
  chatId: number,
  threadId: number,
  nowMs?: number
): DecisionWriteResult {
  try {
    const now = nowMs ?? Date.now();
    const cutoff = new Date(now - 86_400_000).toISOString();

    const db = openDecisions();
    try {
      const stmt = db.prepare(`
        UPDATE decisions
        SET outcome = 'replied', updated_at = ?
        WHERE thread_id = ?
          AND (chat_id IS NULL OR chat_id = ?)
          AND outcome IS NULL
          AND reaction IS NULL
          AND ts >= ?
      `);
      const updated = nowIso();
      const result = stmt.run(updated, threadId, chatId, cutoff);
      return { ok: true, matched: result.changes };
    } finally {
      db.close();
    }
  } catch (err: any) {
    const error = err?.message ?? String(err);
    logger.warn('decisions', 'markRepliedForThread failed', { chatId, threadId, error });
    return { ok: false, error };
  }
}

/**
 * Aggregate decision statistics by skill within a time window.
 *
 * Returns null when the DB file is absent or unreadable — NEVER throws.
 * NULL-skill rows are excluded (source-only rows).
 */
export interface SkillDecisionStats {
  skill: string;
  total: number;
  approved: number;
  rejected: number;
  replied: number;
  pending: number;
  other_reaction: number;
}

export function decisionStatsBySkill(
  fromIso: string,
  toIso?: string
): Map<string, SkillDecisionStats> | null {
  try {
    const dbPath = decisionsDbPath();
    if (!existsSync(dbPath)) {
      return null;
    }

    const to = toIso ?? new Date().toISOString();

    const db = new Database(dbPath, { readonly: true });
    db.pragma('busy_timeout = 3000');
    try {
      const stmt = db.prepare(`
        SELECT
          skill,
          COUNT(*) AS total,
          SUM(outcome = 'approved') AS approved,
          SUM(outcome = 'rejected') AS rejected,
          SUM(outcome = 'replied') AS replied,
          SUM(outcome IS NULL) AS pending,
          SUM(reaction IS NOT NULL AND outcome IS NULL) AS other_reaction
        FROM decisions
        WHERE skill IS NOT NULL AND ts >= ? AND ts <= ?
        GROUP BY skill
      `);

      const rows = stmt.all(fromIso, to) as any[];
      const map = new Map<string, SkillDecisionStats>();

      for (const row of rows) {
        map.set(row.skill, {
          skill: row.skill,
          total: row.total,
          approved: row.approved,
          rejected: row.rejected,
          replied: row.replied,
          pending: row.pending,
          other_reaction: row.other_reaction,
        });
      }

      return map;
    } finally {
      db.close();
    }
  } catch (err: any) {
    const error = err?.message ?? String(err);
    logger.warn('decisions', 'decisionStatsBySkill failed', { error });
    return null;
  }
}

export { decisionsDbPath };
