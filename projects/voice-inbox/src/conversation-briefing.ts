/**
 * Conversation briefing (AI-conversation-context, Piece 1, 2026-09-10).
 *
 * The target-topic worker (`buildTargetInjectionText`) and, when a task is a
 * known continuation, the two inbox routing texts each get a bounded prose
 * recap of the conversation's prior turns, so a follow-up like "make it
 * shorter" is answerable without the worker re-asking what "it" refers to.
 *
 * Contract: `CONTRACTS.md` § "Conversation briefing (2026-09-10)". The
 * rendered format below is FROZEN — this is the golden implementation;
 * `scripts/route_task.py` carries an independent twin that must render
 * byte-identically for the same inputs (pinned by
 * `tests/test_worker_scripts.py`'s `GOLDEN_BRIEFING`/`EXPECTED_TARGET_TEXT`).
 *
 * The briefing slot is wired into `buildTargetInjectionText` (and the two
 * inbox builders) as a `${}` interpolation INSIDE the pinned backtick
 * literal — never a `+`-joined segment outside it — because
 * `sync-twins.test.ts`'s extraction regex cannot see the latter and the two
 * languages could silently diverge with a green pin.
 */

import type Database from 'better-sqlite3';
import { getConversationMeta, listConversationTasks } from './ledger.js';
import { buildTargetInjectionText, type FeedbackRef } from './bridge-writer.js';

// --- Constants (§3.1) --------------------------------------------------------

/** Hard cap on the whole briefing string. */
export const CONVERSATION_BRIEFING_MAX = 1200;
/** Below this budget no briefing is built at all. */
export const CONVERSATION_BRIEFING_MIN = 200;
/** Per-field clamp for a request or an answer. */
export const CONVERSATION_BRIEFING_FIELD_MAX = 400;
/** Cap for the two inbox texts (routing needs the head, not the turns). */
export const INBOX_BRIEFING_MAX = 300;
/** Hand-copy of the bot's `STEER_MESSAGE_MAX`; cross-package pinned by this
 * module's own test (fixture G) — a moved bot constant fails there first. */
export const STEER_MESSAGE_LIMIT = 4000;
/** Whole-injection-text ceiling = `STEER_MESSAGE_LIMIT - 50`. The 200-char
 * margin was consumed by the pinned surface sentence (2026-09-13, feedback
 * long-press); recalibrated to 50 — future template growth now fails the
 * python end-to-end steer-limit gate visibly instead of being silently
 * absorbed. */
export const ROUTE_TEXT_MAX = STEER_MESSAGE_LIMIT - 50;
/** Appended to a clamped field. */
export const BRIEFING_TRIM_MARKER = ' [trimmed]';

export interface BriefingOptions {
  conversationId: string;
  excludeTaskId: string;
  /** Rendered forward-slashed by the caller or by ledgerPathOf. */
  ledgerPath: string;
  maxChars: number;
}

// --- Field rendering (§3.2) ---------------------------------------------------

/**
 * Collapse whitespace, trim, neutralise the `[Voice task ` / `[Voice inbox
 * task ` bracket shape (§1.8 — that literal is what `taskIdsInText` scans
 * for; echoing it back into a briefing would inject spurious ids into
 * `steerIntoWork`'s idempotency and origin matching), then clamp at
 * `CONVERSATION_BRIEFING_FIELD_MAX` with `BRIEFING_TRIM_MARKER`. `null` /
 * `undefined` render as `''`.
 */
function renderField(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let value = raw.replace(/\s+/g, ' ').trim();
  if (value.length === 0) return '';
  value = value
    .replaceAll('[Voice task ', '(voice task ')
    .replaceAll('[Voice inbox task ', '(voice inbox task ');
  if (value.length > CONVERSATION_BRIEFING_FIELD_MAX) {
    value = value.slice(0, CONVERSATION_BRIEFING_FIELD_MAX) + BRIEFING_TRIM_MARKER;
  }
  return value;
}

/**
 * The single lookup line replacing the old per-turn dump: a runnable
 * `sqlite3` query against the ledger, not the prior turns inlined. Workers
 * already run direct `sqlite3` queries against this exact ledger file in
 * production, so this hands over a proven retrieval path instead of a dead
 * bare id.
 */
function lookupLine(conversationId: string, ledgerPath: string): string {
  return (
    `Full turn-by-turn record: sqlite3 "${ledgerPath}" "SELECT created_at, request_text, ` +
    `result_summary FROM tasks WHERE conversation_id = '${conversationId}' ORDER BY created_at ASC".\n`
  );
}

// --- Public API ----------------------------------------------------------------

/** `db.name` (the path better-sqlite3 was opened with) forward-slashed. */
export function ledgerPathOf(db: Database.Database): string {
  return db.name.replace(/\\/g, '/');
}

/**
 * Build the bounded conversation briefing (§3.2 format, implemented
 * verbatim). Returns `''` when the conversation has no prior turns, when
 * `maxChars` cannot fit even the head + lookup line + foot, or when the
 * assembled result would exceed `maxChars` (the terminating guard — this
 * function NEVER returns a string longer than `options.maxChars`).
 */
export function buildConversationBriefing(
  db: Database.Database,
  tenantId: string,
  options: BriefingOptions
): string {
  const prior = listConversationTasks(db, tenantId, options.conversationId).filter(
    (t) => t.task_id !== options.excludeTaskId
  );
  const n = prior.length;
  if (n === 0) return '';

  const meta = getConversationMeta(db, tenantId, options.conversationId);
  const headLines: string[] = [
    `Conversation so far (${options.conversationId}): ${n} earlier turn(s), oldest first.\n`,
  ];
  const title = renderField(meta?.title);
  if (title.length > 0) headLines.push(`Title: ${title}\n`);
  const recap = renderField(meta?.recap);
  if (recap.length > 0) headLines.push(`Where it stands: ${recap}\n`);
  const nextAction = renderField(meta?.next_action);
  if (nextAction.length > 0) headLines.push(`Next: ${nextAction}\n`);
  const head = headLines.join('');
  const foot = 'End of the conversation record.\n';

  const result = head + lookupLine(options.conversationId, options.ledgerPath) + foot;
  if (result.length > options.maxChars) return ''; // terminating guard: never overflow
  return result;
}

/**
 * `Math.min(cap, ROUTE_TEXT_MAX - baseLength)` (§3.4) — the budget left for a
 * briefing once `baseLength` characters of the rest of the injection text are
 * already spoken for. Can return a negative number; callers compare against
 * `CONVERSATION_BRIEFING_MIN` before building anything.
 */
export function briefingBudget(baseLength: number, cap: number = CONVERSATION_BRIEFING_MAX): number {
  return Math.min(cap, ROUTE_TEXT_MAX - baseLength);
}

/**
 * `buildTargetInjectionText` (bridge-writer.ts) plus its conversation
 * briefing, computed by rendering the base text once (§3.4's two-pass
 * budget) and passing the result as `conversationBriefing`. The extra field
 * is threaded through an untyped intermediate object rather than an inline
 * literal on purpose: `buildTargetInjectionText`'s parameter type gains
 * `conversationBriefing?: string` only once WP-2 lands (this module is built
 * and landed first, §7.1), and TypeScript's excess-property check would
 * reject a literal carrying a field the not-yet-updated type doesn't
 * declare; a variable of the (wider) inferred type is still structurally
 * assignable to the narrower parameter type both before and after that
 * field lands, so this compiles unchanged across the WP-1 → WP-2 boundary.
 */
export function buildTargetInjectionTextWithBriefing(
  db: Database.Database,
  tenantId: string,
  input: {
    taskId: string;
    requestText: string;
    reason: string;
    repoRoot: string;
    attachments?: readonly string[];
    conversationId: string;
    feedback?: FeedbackRef;
  }
): string {
  const baseInput = {
    taskId: input.taskId,
    requestText: input.requestText,
    reason: input.reason,
    repoRoot: input.repoRoot,
    ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
    ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
  };
  const base = buildTargetInjectionText(baseInput);
  const budget = briefingBudget(base.length);
  const briefing =
    budget >= CONVERSATION_BRIEFING_MIN
      ? buildConversationBriefing(db, tenantId, {
          conversationId: input.conversationId,
          excludeTaskId: input.taskId,
          ledgerPath: ledgerPathOf(db),
          maxChars: budget,
        })
      : '';
  const finalInput = { ...baseInput, conversationBriefing: briefing };
  return buildTargetInjectionText(finalInput);
}
