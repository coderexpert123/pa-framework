/**
 * worker-reply.ts — AI-173 phase 6 (2026-09-14).
 *
 * Behavior-preserving extraction of the reply pipeline out of logic.ts: the
 * pending-action/confirmation/question state machine (C5), the PA_META
 * parse/apply + premature-async guard + chip/dependency guards (C6), and
 * the markdown/worker-reply formatting pipeline (C7). PA_META_PROTECTED_SKILLS
 * moved WITH C6 to kill the C6→C1 cycle; WorkerResult moved WITH C7.
 * logic.ts re-exports all moved symbols (permanent barrel — importers keep
 * ../logic.js byte-untouched). This module is a leaf: it imports only from
 * ./types.js and pa/dist — never from ./logic.js (no cycle).
 * Spec: the AI-173 phase 6 design (2026-09-14, internal).
 */

import type {
  ConversationState,
  PAMeta,
  PendingQuestion,
} from './types.js';
import { validateWatchInput } from '../../../pa/dist/src/lib/watch-jobs.js';
import type { WatchInput } from '../../../pa/dist/src/lib/watch-jobs.js';
import { logger } from '../../../pa/dist/src/lib/log.js';

export interface WorkerResult {
  success: boolean;
  output: string;
  error?: string;
  evaluatorSummary?: string; // user-facing summary from LLM evaluator when worker is killed
}

// PA_META run_skill authorization (2026-08-17 audit P1-2). These skills may only be
// invoked by explicit human commands (/commit, /push, etc.) — never via PA_META
// run_skill, because LLM inference about when to git-commit/push is too unreliable for
// an operation that mutates the live tree.
export const PA_META_PROTECTED_SKILLS = new Set([
  'self-improver',
  'commit',
  'push',
  'push-public',
  'investigate-flagged',
  'update-brain',
]);

export const CONFIRMATION_YES = /^(yes|yeah|yep|confirm|do\s+it|go\s+ahead|ok(?:ay)?|sure)\b/i;
export const CONFIRMATION_NO = /^(no|nah|nope|cancel|nevermind|never\s+mind|don'?t|stop)\b/i;
export const CONFIRMATION_PATTERN = /reply \*?yes\*? to confirm/i;

export const PENDING_ACTION_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function expirePendingAction(state: ConversationState): void {
  if (!state.pending_action) return;
  const age = Date.now() - new Date(state.pending_action.proposed_at).getTime();
  if (age >= PENDING_ACTION_TTL_MS) {
    state.pending_action = undefined;
  }
}

export function resolveConfirmation(
  state: ConversationState,
  userText: string
): { response: string; skipWorker: boolean } {
  if (!state.pending_action) return { skipWorker: false, response: '' };

  const isShort = userText.trim().length <= 25;

  if (isShort && CONFIRMATION_NO.test(userText)) {
    state.pending_action = undefined;
    return { skipWorker: true, response: 'Cancelled.' };
  }

  if (isShort && CONFIRMATION_YES.test(userText)) {
    // Leave pending_action intact — main.ts clears it before dispatch
    return { skipWorker: false, response: '' };
  }

  // Unrelated message — clear pending and let worker handle it
  state.pending_action = undefined;
  return { skipWorker: false, response: '' };
}

/** Reads the pending action's description and CLEARS it, so a second "yes" (typed,
 *  tapped, or 👍'd) inside the 5-minute TTL cannot re-run the same confirmed action.
 *  Implements what resolveConfirmation's own comment has claimed since it was written
 *  (main.ts never did clear it — plans/2026-08-24-buttons-program-SPEC.md correction 3). */
export function consumeConfirmation(state: ConversationState): string | undefined {
  const desc = state.pending_action?.description;
  state.pending_action = undefined;
  return desc;
}

/** Mirrors expirePendingAction for the PA_META `question` prompt (2026-09-02, handover
 *  Wave 1 SPEC §3.3) — same TTL. Called from main.ts's per-turn cluster (WP-F);
 *  exported-but-uncalled until then, tested directly. */
export function expirePendingQuestion(state: ConversationState): void {
  if (!state.pending_question) return;
  const age = Date.now() - new Date(state.pending_question.asked_at).getTime();
  if (age >= PENDING_ACTION_TTL_MS) {
    state.pending_question = undefined;
  }
}

/** Typed-answer path for a pending PA_META `question`: when the turn's text matches one
 *  of the question's options (exact after trim, case-insensitive), the question is
 *  consumed and the matched option text returned — so a plain typed reply resolves the
 *  buttons exactly like a `q:` press does. Returns undefined when nothing is pending or
 *  the text matches no option (non-matching turns fall through to the worker
 *  untouched). Called from main.ts (WP-F); exported-but-uncalled until then. */
export function resolveQuestionAnswer(state: ConversationState, userText: string): string | undefined {
  const question = state.pending_question;
  if (!question) return undefined;
  const normalized = userText.trim().toLowerCase();
  const matched = question.options.find((option) => option.trim().toLowerCase() === normalized);
  if (matched === undefined) return undefined;
  state.pending_question = undefined;
  return matched;
}

// AI-029 (hardened 2026-08-05, ekadashi-topic incident): resolves a pending
// auto-suggested topic description against the user's next message. Pure —
// mutates state.pendingDescription but performs no I/O; the caller applies
// `acceptDescriptionText` via setTopicDescription itself. Kept separate from
// the setTopicDescription call so this can be unit tested without spawning a
// worker via the caller's dispatch fallthrough.
export function resolvePendingDescription(
  state: ConversationState,
  userText: string,
  opts: { voiceTranscribed: boolean; now?: number }
): { response: string; skipWorker: boolean; acceptDescriptionText?: string } {
  const pd = state.pendingDescription;
  if (!pd) return { skipWorker: false, response: '' };

  const now = opts.now ?? Date.now();
  if (now > pd.expiresAt) {
    // Stale prompt — the type contract says "auto-accept if now > expiresAt".
    // Resolve it on its own terms rather than on THIS message: a reply may
    // arrive days late and be unrelated to the original prompt (e.g. a voice
    // note answering something else entirely). Auto-accept the suggestion if
    // the bot had one; otherwise there's nothing to accept. Either way, let
    // this message fall through to normal dispatch instead of being
    // swallowed as the description.
    state.pendingDescription = undefined;
    if (pd.text && pd.text.length > 0) {
      return { skipWorker: false, response: '', acceptDescriptionText: pd.text };
    }
    return { skipWorker: false, response: '' };
  }

  const short = userText.trim().length <= 25;

  if (short && CONFIRMATION_NO.test(userText)) {
    state.pendingDescription = undefined;
    return { skipWorker: true, response: 'OK, skipped.' };
  }

  if (short && CONFIRMATION_YES.test(userText)) {
    if (pd.text && pd.text.length > 0) {
      state.pendingDescription = undefined;
      return { skipWorker: true, response: 'Description set.', acceptDescriptionText: pd.text };
    }
    return { skipWorker: true, response: "Okay — type the description and I'll save it." };
  }

  if (!short && !opts.voiceTranscribed) {
    // User typed a substantive line instead of yes/no → treat it as the
    // description. Voice-transcribed text is excluded: a spoken message is
    // almost never an intentional answer to "what's this topic for?" and
    // swallowing it silently drops whatever the user actually asked.
    state.pendingDescription = undefined;
    return { skipWorker: true, response: 'Description set.', acceptDescriptionText: userText.trim() };
  }

  // Short-but-not-yes/no, or a voice-transcribed substantive message: leave
  // pendingDescription intact and let this message fall through undisturbed.
  return { skipWorker: false, response: '' };
}

/**
 * AI-202 (2026-09-04): true when a turn's final response is a contentless
 * "launched, waiting" promise — the option-B outcome of a CLI harness
 * background-tool decision prompt. Such text must never be delivered as the
 * answer to a Telegram message (incident 2026-09-04 ~07:39 IST, thread 8306:
 * "I have launched the git log check and will review the output once it
 * completes." was posted as the whole reply and the real work was lost).
 *
 * Deliberately narrow, anchored on the two real instances:
 *  - length cap 240: the incident reply is 78 chars; the same-morning
 *    legitimate reply that merely LED with a promise (tee fbfe1348) is ~900
 *    chars and must NOT be suppressed.
 *  - deliverable veto: any absolute path, URL, code fence, heading, list
 *    item or ref id means there is real content — never suppress.
 * Callers must gate on meta === null so the AI-170-sanctioned
 * "promise + registered watch_job" shape is never suppressed.
 */
export function isPrematureAsyncReply(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t || t.length > 240) return false;
  if (/https?:\/\/|[A-Za-z]:[\\/]|```|^#{1,6}\s/m.test(t)) return false;
  if (/^\s*([-*]|\d+[.)])\s+\S/m.test(t)) return false;
  if (/\bs-[0-9a-f]{12}\b/i.test(t)) return false;
  const launched = /\b(launched|kicked off|dispatched|queued)\b/i.test(t)
    || /\b(task-\d+)\b/i.test(t);
  const waiting = /\b(waiting|will wait|wait for it|once it (completes|finishes)|when it (completes|finishes)|will (review|report|follow up)|let you know|report back)\b/i.test(t);
  return launched && waiting;
}

/** First 120 chars of a raw candidate JSON string, for warn-log excerpts
 *  (2026-09-09 incident: callers need SOMETHING to log/report besides
 *  "actions dropped" — the incident's own app.log had zero trace of it). */
const PA_META_RAW_EXCERPT_CHARS = 120;

/**
 * Conservative JSON repair for a PA_META envelope candidate (2026-09-09
 * incident, topic 13052): a worker that echoes a Windows absolute path
 * verbatim into a JSON string literal (`"D:\Personal Assistant\..."`)
 * produces lone backslashes — `\P`, `\p` — that JSON.parse rejects with
 * "Invalid \escape" even though the envelope is otherwise well-formed.
 * Escapes exactly those: a `\` NOT already followed by a valid JSON escape
 * character (`["\\/bfnrtu]`) becomes `\\`. Already-valid escapes (`\"`,
 * `\\`, `\n`, ...) are left untouched, and this never touches anything
 * about the parsed CONTENT — a candidate malformed for any other reason
 * still fails to parse afterward, same as before the repair.
 */
export function repairLoneBackslashes(candidate: string): string {
  return candidate.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

/**
 * Lenient salvage normalize for a PA_META envelope candidate (2026-09-11/13
 * orchestrator-turn deaths, "Bad escaped character" poison class: a retry
 * cannot fix a deterministic parse failure, so the envelope needs a second
 * chance at parse time). Two deterministic passes, run only AFTER the plain
 * and lone-backslash repair attempts have both failed:
 *   1. Strip raw C0 control characters except the structural newline (\n).
 *      A raw control char inside a string literal is unparseable JSON,
 *      while between tokens it is transport noise whose removal is
 *      parse-neutral (inter-token tab/CR whitespace is optional in JSON).
 *      In-string removal munges that string's content — the accepted
 *      salvage contract: a delivered action beats a dead turn.
 *   2. The lone-backslash escape repair, catching poison the control-strip
 *      exposes (e.g. `\` separated from its escape char by transport noise)
 *      or that coexists with the control-char defect.
 * This is a normalize-and-retry second chance, NOT a general JSON repair
 * library: an envelope malformed for any structural reason still fails
 * afterward, exactly as it would without the salvage.
 */
function sanitizeMetaEnvelope(candidate: string): string {
  // Code-point filter ON PURPOSE: no char-class regex, so this source file
  // carries no raw control bytes and no escape-sequence lookalikes (a
  // raw-byte regex here poisoned the file once, 2026-09-13).
  const stripped = Array.from(candidate)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c > 0x1f || c === 0x0a;
    })
    .join('');
  return repairLoneBackslashes(stripped);
}

function jsonParseErrorMessage(candidate: string): string {
  try {
    JSON.parse(candidate);
    return 'unknown parse error';
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * Parse and strip the [PA_META] envelope from worker output.
 *
 * `parseError`/`rawExcerpt` are set only when a `[PA_META]:` envelope was
 * PRESENT but never parsed into actions — including after the backslash
 * repair above AND the lenient sanitize-and-reparse salvage — so a caller
 * that posts the reply to a chat (orchestrator.ts) can fail LOUDLY (footer +
 * warn log + topic event) instead of the failure disappearing the way it did
 * in the 2026-09-09 incident (console.warn only, no footer, no topic event,
 * `meta: null` with no signal why). `repaired` is set when the envelope
 * parsed only after that repair; a salvage win instead logs its own info
 * line and returns without `repaired` (quieter tier — the orchestrator's
 * `repaired` footer text is backslash-specific).
 */
export function parseMetadata(output: string, executionMode = false): {
  cleaned: string;
  meta: PAMeta | null;
  parseError?: string;
  rawExcerpt?: string;
  repaired?: boolean;
} {
  const withMeta = (cleaned: string, meta: PAMeta | null, extra?: { repaired?: boolean }) =>
    ({ cleaned, meta: executionMode ? null : meta, ...extra });

  const MARKER = '[PA_META]:';
  const nlMarker = '\n' + MARKER;
  const nlPos = output.lastIndexOf(nlMarker);

  let cleanedEnd: number;
  let markerLineStart: number;

  if (nlPos >= 0) {
    cleanedEnd = nlPos;
    markerLineStart = nlPos + 1;
  } else if (output.startsWith(MARKER)) {
    cleanedEnd = 0;
    markerLineStart = 0;
  } else {
    const altNlMarker = '\nPA_META:';
    const altNlPos = output.lastIndexOf(altNlMarker);
    if (altNlPos >= 0 && !output.slice(altNlPos + altNlMarker.length).includes('\n')) {
      return withMeta(output.slice(0, altNlPos).trim(), null);
    }
    return withMeta(output, null);
  }

  const afterMarkerContent = output.slice(markerLineStart + MARKER.length).trimStart();
  if (!afterMarkerContent.startsWith('{')) {
    return withMeta(output.slice(0, cleanedEnd).trim(), null);
  }

  const jsonStart = output.indexOf('{', markerLineStart + MARKER.length);
  const jsonStr = output.slice(jsonStart).trimEnd();
  const cleaned = output.slice(0, cleanedEnd).trim();

  function tryParseMeta(candidate: string): PAMeta | null | undefined {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (!parsed || !Array.isArray(parsed['actions'])) return null;
      return parsed as unknown as PAMeta;
    } catch {
      return undefined;
    }
  }

  // Lenient salvage (2026-09-11/13 "Bad escaped character" deaths): LAST
  // chance after the plain and lone-backslash attempts — sanitize
  // control-char/escape poison and re-parse once. Success logs exactly one
  // line and proceeds normally: deliberately WITHOUT the `repaired` flag,
  // which drives the orchestrator's backslash-specific footer; sanitize is
  // its own quieter tier. Failure returns undefined and falls through to the
  // existing give-up behavior below, byte-identical.
  function salvagedMeta(candidate: string): PAMeta | null | undefined {
    const sanitized = sanitizeMetaEnvelope(candidate);
    if (sanitized === candidate) return undefined; // nothing to fix — plain+repair already covered this text
    const parsed = tryParseMeta(sanitized);
    if (parsed === undefined) return undefined;
    logger.info('logic', 'PA_META envelope salvaged after sanitize', {
      excerpt: candidate.slice(0, PA_META_RAW_EXCERPT_CHARS),
    });
    return parsed;
  }

  const firstAttempt = tryParseMeta(jsonStr);
  if (firstAttempt !== undefined) return withMeta(cleaned, firstAttempt);

  // 2026-09-09 incident repair: try once more with lone backslashes escaped
  // before falling through to the artifact-trim / give-up paths below.
  const repairedStr = repairLoneBackslashes(jsonStr);
  const repairAttempted = repairedStr !== jsonStr;
  if (repairAttempted) {
    const repairedAttempt = tryParseMeta(repairedStr);
    if (repairedAttempt !== undefined) return withMeta(cleaned, repairedAttempt, { repaired: true });
  }

  const lastBrace = jsonStr.lastIndexOf('}');
  if (lastBrace >= 0) {
    const trailing = jsonStr.slice(lastBrace + 1).trim();
    const isArtifactOnly = trailing === '' || /^<\/?\w[\w-]*>$/.test(trailing);
    if (isArtifactOnly) {
      const candidate = jsonStr.slice(0, lastBrace + 1);
      const secondAttempt = tryParseMeta(candidate);
      if (secondAttempt !== undefined) return withMeta(cleaned, secondAttempt);
      const repairedCandidate = repairLoneBackslashes(candidate);
      if (repairedCandidate !== candidate) {
        const repairedSecondAttempt = tryParseMeta(repairedCandidate);
        if (repairedSecondAttempt !== undefined) return withMeta(cleaned, repairedSecondAttempt, { repaired: true });
      }
      const salvageAttempt = salvagedMeta(candidate);
      if (salvageAttempt !== undefined) return withMeta(cleaned, salvageAttempt);
      // Distinguish empty artifact (preserves envelope) from real artifact (strips marker)
      if (trailing === '') {
        // Empty trailing artifact: malformed JSON only, preserve envelope with warning
        console.warn('[pa-meta] failed to parse envelope, actions dropped', { tail: output.slice(-80) });
        return {
          ...withMeta(output, null),
          parseError: jsonParseErrorMessage(repairAttempted ? repairedStr : jsonStr),
          rawExcerpt: jsonStr.slice(0, PA_META_RAW_EXCERPT_CHARS),
        };
      }
      // Real trailing artifact (e.g. </invoke>): strip marker silently
      return withMeta(cleaned, null);
    }
  }

  // Lenient salvage (2026-09-11/13): last chance on the extracted envelope
  // before the give-up below; failure keeps every existing give-up byte.
  const salvageAttempt = salvagedMeta(jsonStr);
  if (salvageAttempt !== undefined) return withMeta(cleaned, salvageAttempt);

  // Without trailing artifact: full envelope + warn
  console.warn('[pa-meta] failed to parse envelope, actions dropped', { tail: output.slice(-80) });
  return {
    ...withMeta(output, null),
    parseError: jsonParseErrorMessage(repairAttempted ? repairedStr : jsonStr),
    rawExcerpt: jsonStr.slice(0, PA_META_RAW_EXCERPT_CHARS),
  };
}

/**
 * Model-requestable spawn dependency (2026-09-13): a spawn_thread action may
 * carry depends_on — up to 3 thread ids ("t-<n>") from the Execution threads
 * section that the new thread must wait on. Fail-open like the rest of the
 * route parsing: malformed/duplicate/over-cap entries are dropped (one
 * aggregated warning), never a rejection; nothing well-formed surviving drops
 * the field entirely. Existence is NOT checked here — createThread's own
 * sanitizer intersects with the store at spawn time, so an id that matched
 * nothing degrades to a plain spawn.
 */
export function sanitizeSpawnDependsOn(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    console.warn('[pa-meta] spawn depends_on dropped: not an array');
    return undefined;
  }
  const ids: string[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (typeof entry === 'string' && /^t-\d+$/.test(entry) && !ids.includes(entry)) {
      if (ids.length < 3) ids.push(entry);
      else dropped++;
    } else {
      dropped++;
    }
  }
  if (ids.length === 0) {
    console.warn('[pa-meta] spawn depends_on dropped: no well-formed t-<n> id');
    return undefined;
  }
  if (dropped > 0) console.warn(`[pa-meta] spawn depends_on: dropped ${dropped} invalid/duplicate/over-cap entries`);
  return ids;
}

// ---------------------------------------------------------------------------
// AI-234: quick-reply chip plain-language guard
// ---------------------------------------------------------------------------

export const SUGGESTED_ITEM_MAX = 4;
export const SUGGESTED_ITEM_LABEL_MAX = 40;

/** AI-234 plain-language guard regex (vi-314acd845cd3). A chip matching ANY
 *  alternative is dropped. Byte-synced to Builder B's Python twin in
 *  task_complete.py — the canonical pattern string is:
 *    [`{}[\]<>|=]|//|\\|\.\w{1,4}\b|http|0x[0-9a-fA-F]+
 *  Alternatives: backtick, braces, brackets, angle brackets, equals, pipe,
 *  double-slash, backslash, file extensions (dot + 1-4 word chars at a word
 *  boundary), the literal "http", and 0x-prefixed hex runs. */
const SUGGESTED_ITEM_NONPLAIN_RE = /[`{}[\]<>|=]|\/\/|\\|\.\w{1,4}\b|http|0x[0-9a-fA-F]+/;

/** AI-234 plain-language guard (vi-314acd845cd3). Drops any chip that is not
 *  plain product language: empty, too long, or containing code symbols
 *  (backticks, braces, brackets, angle brackets, slashes, backslashes,
 *  equals, pipes, file extensions, path-like runs, JSON/code punctuation,
 *  URLs). Fail-OPEN: keep the survivors, drop the offenders, warn-log the
 *  drop. Chips are additive — losing one must never lose the answer. */
export function sanitizeSuggestedItems(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const survivors: string[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (survivors.length >= SUGGESTED_ITEM_MAX) {
      dropped++;
      continue;
    }
    if (typeof entry !== 'string') { dropped++; continue; }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > SUGGESTED_ITEM_LABEL_MAX) {
      dropped++;
      continue;
    }
    if (SUGGESTED_ITEM_NONPLAIN_RE.test(trimmed)) {
      dropped++;
      continue;
    }
    survivors.push(trimmed);
  }
  if (dropped > 0) {
    logger.warn('logic', `sanitizeSuggestedItems: dropped ${dropped} non-plain/over-cap chip(s)`, { survivors: survivors.length });
  }
  return survivors;
}

/** PA_META action types the orchestrator lane does not handle itself and must
 *  pass through to applyMetaActions (the orchestrator loop owns spawn_thread /
 *  steer_thread only). A type in neither place is rejected loudly by the
 *  orchestrator loop (2026-09-15: a model copied a template placeholder type
 *  verbatim and the action vanished silently). `retry_with_worker` rides here
 *  as a documented no-op — dispatch ignores it by design. Keep in step with the
 *  branches below; the orchestrator's else-branch and its parity test read
 *  THIS set. */
export const PA_META_DOWNSTREAM_TYPES: ReadonlySet<string> = new Set([
  'restart_bot',
  'kb_note',
  'watch_job',
  'question',
  'confirm_required',
  'run_skill',
  'retry_with_worker',
]);

/**
 * Apply PA_META actions and the text-based CONFIRMATION_PATTERN to a worker response.
 */
export function applyMetaActions(
  response: string,
  meta: PAMeta | null,
  state: ConversationState
): { response: string; skillToRun: string | null; restartBot: boolean; kbNote: { domain: string; note: string } | null; watchJob: WatchInput | null } {
  let out = response;
  let restartBot = false;
  let kbNote: { domain: string; note: string } | null = null;
  let watchJob: WatchInput | null = null;

  if (meta?.actions.some((a) => a.type === 'restart_bot')) {
    restartBot = true;
    out += `\n\n_(Restarting bot for deployment...)_`;
  }

  // AI-101 Layer 2: a worker that changes a system of record another topic's
  // domain depends on can record it into Ecosystem KB Sources.md the same
  // turn, instead of waiting for the nightly ecosystem-kb skill sweep. Pure
  // extraction/validation only — main.ts performs the actual file write.
  const kbNoteAction = meta?.actions.find((a) => a.type === 'kb_note');
  if (kbNoteAction) {
    const domain = kbNoteAction.domain?.trim();
    const note = kbNoteAction.note?.trim();
    if (domain && note && domain.length <= 100 && note.length <= 300) {
      kbNote = { domain, note };
    } else {
      console.warn(`[pa-meta] kb_note rejected — domain/note missing or too long (domain=${domain?.length ?? 0} chars, note=${note?.length ?? 0} chars)`);
    }
  }

  // AI-170: a worker that starts something finishing later registers a watch instead of
  // promising to "report back". Shape validation happens here (pure, no I/O) against pa's
  // single validateWatchInput; the store write and the visible outcome line happen in main.ts,
  // which is the only place the minted id exists (SPEC §1 C12).
  const watchAction = meta?.actions.find((a) => a.type === 'watch_job');
  if (watchAction) {
    const candidate: WatchInput = {
      description: (watchAction.description ?? '').trim(),
      check: {
        type: watchAction.check?.type ?? '',
        path: watchAction.check?.path,
        pattern: watchAction.check?.pattern,
        sinceIso: watchAction.check?.since_iso,
        pid: watchAction.check?.pid,
      },
      intervalSeconds: watchAction.interval_seconds,
      deadlineMinutes: watchAction.deadline_minutes,
      source: {
        kind: 'pa_meta',
        chatId: String(state.chat_id),
        threadId: state.thread_id,
        refId: null,
      },
    };
    const check = validateWatchInput(candidate);
    if (check.ok) {
      watchJob = candidate;
    } else {
      console.warn(`[pa-meta] watch_job rejected — ${check.error}`);
      out += `\n\n_(watch_job rejected: ${check.error})_`;
    }
  }

  // PA_META `question` (2026-09-02, handover Wave 1 SPEC §3.3): a closed-shape,
  // operator-visible option prompt. Arming here is pure state mutation (same pattern as
  // pending_action below — no new return field); main.ts renders the keyboard at the
  // send site (WP-F attach cascade: confirm wins over question). Mutual exclusion is
  // enforced BEFORE shape validation so a question that could never be attached is
  // never armed: reject when a pending_action is already live or the same envelope
  // carries confirm_required — an unattachable orphan keyboard is the failure mode.
  const questionAction = meta?.actions.find((a) => a.type === 'question');
  if (questionAction) {
    if (state.pending_action) {
      const reason = 'a pending_action confirmation is already active';
      console.warn(`[pa-meta] question rejected — ${reason}`);
      out += `\n\n_(question rejected: ${reason})_`;
    } else if (meta?.actions.some((a) => a.type === 'confirm_required')) {
      const reason = 'confirm_required takes precedence in the same reply';
      console.warn(`[pa-meta] question rejected — ${reason}`);
      out += `\n\n_(question rejected: ${reason})_`;
    } else {
      const qText = typeof questionAction.text === 'string' ? questionAction.text.trim() : '';
      const rawOptions = Array.isArray(questionAction.options) ? questionAction.options : [];
      const options = rawOptions.filter((o): o is string => typeof o === 'string').map((o) => o.trim());
      const taskId = typeof questionAction.task_id === 'string' ? questionAction.task_id : undefined;
      const taskIdOk = taskId === undefined || (taskId.length <= 64 && /^[A-Za-z0-9_-]*$/.test(taskId));
      const optionsOk =
        rawOptions.length >= 1 &&
        rawOptions.length <= 4 &&
        rawOptions.every((o) => typeof o === 'string' && o.trim().length >= 1 && o.trim().length <= 40);
      if (qText.length < 1 || qText.length > 500) {
        const reason = 'text must be 1..500 chars';
        console.warn(`[pa-meta] question rejected — ${reason}`);
        out += `\n\n_(question rejected: ${reason})_`;
      } else if (!optionsOk) {
        const reason = 'options must be 1..4 strings of 1..40 chars';
        console.warn(`[pa-meta] question rejected — ${reason}`);
        out += `\n\n_(question rejected: ${reason})_`;
      } else if (!taskIdOk) {
        const reason = 'taskId must be <=64 chars [A-Za-z0-9_-]';
        console.warn(`[pa-meta] question rejected — ${reason}`);
        out += `\n\n_(question rejected: ${reason})_`;
      } else {
        state.pending_question = {
          text: qText,
          options,
          task_id: taskId,
          asked_at: new Date().toISOString(),
        } satisfies PendingQuestion;
      }
    }
  }

  // Zombie-confirmations fix (2026-08-30 SPEC): arm from the text pattern only
  // when the phrase sits on the LAST non-empty line of the reply — a mid-text
  // mention in an unrelated reply must not arm a pending_action. Verified in
  // main.ts: the `_Ref:` footer is appended at send time (main.ts:2194), after
  // the applyMetaActions call (main.ts:2112), so `out` here never carries a
  // ref/footer line — no footer exclusion needed. The restart_bot footer
  // appended above (logic.ts:1403) DOES displace the anchor: a reply that both
  // ends with the phrase and carries a restart_bot action no longer arms via
  // the text path; confirm_required remains the reliable meta arm path
  // (pinned by logic.test.ts 'restart_bot footer displaces the text-pattern
  // anchor…').
  const lastLine = out.trimEnd().split('\n').pop()?.trim() ?? '';
  if (lastLine && CONFIRMATION_PATTERN.test(lastLine)) {
    state.pending_action = {
      description: out,
      proposed_at: new Date().toISOString(),
    };
  }

  if (!state.pending_action && meta?.actions.some((a) => a.type === 'confirm_required')) {
    state.pending_action = {
      description: out,
      proposed_at: new Date().toISOString(),
    };
    out += '\n\nReply *yes* to confirm or *no* to cancel.';
  }

  if (!state.pending_action) {
    const runSkillAction = meta?.actions.find((a) => a.type === 'run_skill' && a.skill);
    if (runSkillAction?.skill) {
      const skillName = runSkillAction.skill;
      if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
        console.warn(`[pa-meta] run_skill rejected — invalid skill name: ${skillName}`);
        return { response: out, skillToRun: null, restartBot, kbNote, watchJob };
      }
      if (PA_META_PROTECTED_SKILLS.has(skillName)) {
        console.warn(`[pa-meta] run_skill rejected — protected skill: ${skillName}`);
        out += `\n\n_(Skill trigger blocked: ${skillName} requires an explicit command.)_`;
        return { response: out, skillToRun: null, restartBot, kbNote, watchJob };
      }
      out += `\n\n_(Triggering skill: ${skillName})_`;
      return { response: out, skillToRun: skillName, restartBot, kbNote, watchJob };
    }
  }

  return { response: out, skillToRun: null, restartBot, kbNote, watchJob };
}

/**
 * Normalize CommonMark patterns to Telegram MarkdownV2.
 * Applied to all worker output — harmless for already-correct output.
 * - **bold** → *bold*
 * - # Header / ## Header / ### Header → *Header*
 * - --- horizontal rules → removed
 */
/**
 * Convert standard Markdown (CommonMark) to Telegram MarkdownV2 formatting.
 * Models are instructed to write standard Markdown; this does the deterministic conversion.
 */
export function normalizeMarkdown(text: string): string {
  // 1. Protect code spans and blocks — never transform content inside them.
  // Includes CommonMark double-backtick spans (`` `text` ``) which the bare
  // single-backtick regex would otherwise mis-parse as adjacent empty spans.
  const codeChunks: string[] = [];
  text = text.replace(/```[\s\S]*?```|``[^\n]+?``|`[^`\n]+`/g, (match) => {
    codeChunks.push(match);
    return `\x00CODE${codeChunks.length - 1}\x00`;
  });

  // 1b. Strip pre-existing MarkdownV2 escape sequences.
  // Workers sometimes emit \. \( etc. despite instructions to use standard Markdown.
  // Normalize to plain text so our own formatting conversions work correctly
  // and sanitizeMdV2 doesn't double-escape.
  text = text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1');

  // 2. Headers with **bold** content (e.g. ### **Title**) — strip # and ** together
  text = text.replace(/^#{1,6}\s+\*\*([^*\n]+)\*\*/gm, '*$1*');
  // 3. Remaining headers → *bold header*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // 4. **bold** → *bold* (CommonMark double-asterisk → MarkdownV2 single)
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  // 5. ~~strikethrough~~ → ~strikethrough~ (CommonMark double-tilde → MarkdownV2 single)
  text = text.replace(/~~([^~\n]+)~~/g, '~$1~');
  // 6. Unordered list bullets (- or * at line start) → • bullet
  text = text.replace(/^[ \t]*[-*][ \t]+/gm, '• ');
  // 7. Strip horizontal rules
  text = text.replace(/^-{3,}\s*$/gm, '');

  // 8. Convert markdown tables to preformatted code blocks (while code blocks are still
  // protected as \x00CODE…\x00 markers, so table rows inside existing fences are invisible).
  // Telegram MarkdownV2 has no table support; code blocks preserve monospace structure.
  {
    const lines = text.split('\n');
    const resultLines: string[] = [];
    let tableBuffer: string[] = [];

    const flushTable = () => {
      const hasSeparator = tableBuffer.some((l) => /^\s*\|[\s:|-]+\|\s*$/.test(l));
      if (tableBuffer.length >= 2 && hasSeparator) {
        resultLines.push('```');
        resultLines.push(...tableBuffer);
        resultLines.push('```');
      } else {
        resultLines.push(...tableBuffer);
      }
      tableBuffer = [];
    };

    for (const line of lines) {
      if (/^\s*\|/.test(line)) {
        tableBuffer.push(line);
      } else {
        if (tableBuffer.length > 0) flushTable();
        resultLines.push(line);
      }
    }
    if (tableBuffer.length > 0) flushTable();
    text = resultLines.join('\n');
  }

  // 9. Restore code spans/blocks unchanged.
  text = text.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeChunks[+i]);

  return text.trim();
}

function isNoOutputSentinel(output: string): boolean {
  const trimmed = output.trim();
  if (!trimmed) return false;

  const lastLine = trimmed.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  if (lastLine === 'NO_OUTPUT') return true;

  const compactLeakPattern =
    /(?:^|[\s`"'()[\]{}<>.,!?;:-])NO_OUTPUT$/;
  if (!compactLeakPattern.test(trimmed)) return false;

  const sentinelIndex = trimmed.lastIndexOf('NO_OUTPUT');
  const prefix = trimmed.slice(0, sentinelIndex).trim();
  if (!prefix) return true;

  return /(?:^|[\s`"'()[\]{}<>])(?:checking|inspecting|parsing|reading|filtering|summarizing|reviewing|scanning|looking|searching|analyzing|analysing|verifying|loading|opening|processing|working|i(?:'m| am| will| ll)|let me|need to|going to)\b/i.test(prefix);
}

/**
 * Clean agent output for Telegram.
 */
export function formatWorkerReply(output: string, worker: string): string {
  if (!output.trim()) return '';
  let out = output.trim();

  if (worker === 'agy') {
    const thoughtRegex = /\[Thought: true\]([\s\S]*?)\[Thought: false\]/g;
    const blocks: string[] = [];
    let match;
    while ((match = thoughtRegex.exec(out)) !== null) {
      const content = match[1].trim();
      if (content) blocks.push(content);
    }
    // If there are multiple thought blocks, use the last one (captures multi-step reasoning)
    // If there's one thought block, prefer content after it (the actual response),
    //   but fall back to thought block content if nothing substantive after
    // Otherwise, strip orphaned tags and use remaining content
    if (blocks.length > 1) {
      out = blocks[blocks.length - 1];
    } else if (blocks.length === 1) {
      // Single thought block: check if there's non-whitespace content after it
      const afterLastBlock = out.replace(/\[Thought: true\][\s\S]*?\[Thought: false\]/, '').trim();
      // Check if afterLastBlock is substantive (not just planning headers, noise, or leftover tags)
      const isSubstantiveAfter = afterLastBlock &&
        !/^(\*\*[^*]+\*\*|Planning:|Strategy:|\[Thought)/.test(afterLastBlock) &&
        afterLastBlock.length > 10; // Substantive responses are longer than headers/tags
      if (isSubstantiveAfter) {
        out = afterLastBlock;
      } else {
        out = blocks[0];
      }
    } else {
      // No complete thought blocks: strip orphaned tags and use remaining content
      out = out.replace(/\[Thought: (true|false)\]/g, '').trim();
    }
  } else {
    out = out.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '');
    out = out.replace(/<\/?thought>/gi, '').trim();
  }

  // Remove plain "I will/I'll/I've/I'm" planning statements (agy worker leak)
  // Matches consecutive lines starting with these phrases at the start of output
  out = out.replace(
    /^(?:I will|I'll|I've|I'm)\s+[^\n]*\n+(?:(?:I will|I'll|I've|I'm)\s+[^\n]*\n+)*/,
    ''
  ).trim();

  // Remove bold-prefixed planning statements (claude/zclaude format)
  out = out.replace(
    /^(\*\*[A-Z][^*\n]+\*\*\s+(?:I'(?:ve|m)|I will|I'll|My )[^\n]*\n+)+/,
    ''
  ).trim();

  const noisePrefixes = [
    /^(\*+(Planning|Strategy|Research|Thought|Process)\*+:?\s*)+/i,
    /^(Planning\.\.\.|Strategy:|Research:|Thought:)\s*/i,
  ];

  for (const pattern of noisePrefixes) {
    out = out.replace(pattern, '').trim();
  }

  if (isNoOutputSentinel(out)) return '';

  // AI-184 (2026-09-03): redaction does NOT run on this path anymore. The
  // return value is the DELIVERED reply — the operator's own private chat —
  // and scrubbing here meant their name could never appear in their own chat
  // and name-bearing third-party drafts (wa.me prefill) corrupted in transit.
  // The scrub lives on the persistence/worker-read boundary instead:
  // conversation.ts addTurn (turn store + conversation-history.jsonl archive),
  // dlq.ts appendDlq (DLQ at rest), the logger's context redaction (pa
  // lib/log.ts) and rules-critic's logged excerpt. normalizeMarkdown stays —
  // it is formatting, not redaction.
  return normalizeMarkdown(out);
}

export function buildWorkerResponse(result: WorkerResult, worker: string): string {
  if (result.success && result.output.trim()) {
    return formatWorkerReply(result.output, worker);
  }

  if (!result.success) {
    if (result.evaluatorSummary?.trim()) {
      // AI-184 (2026-09-03): delivered failure summary — same reasoning as
      // formatWorkerReply above; the scrub lives on the persistence/log paths.
      return normalizeMarkdown(result.evaluatorSummary.trim());
    }
    const snippet = result.error ? ` (${result.error})` : '';
    return `Sorry, I couldn't process that.${snippet}`;
  }

  return '';
}

export function buildWorkerErrorResponse(args: {
  worker: string;
  exitCode?: number | null;
  stderr?: string;
  emptyResponse?: boolean;
  suggestedWorker: string | null;
}): string {
  const { worker, exitCode, stderr, emptyResponse, suggestedWorker } = args;
  const suggestion = suggestedWorker
    ? `Try again, or switch with /agent ${suggestedWorker}.`
    : `Try again (all other workers cooling down or unavailable).`;

  if (emptyResponse) {
    return `⚠️ ${worker} returned an empty response.\n\n${suggestion}`;
  }

  const exitSuffix = exitCode != null && exitCode >= 0 ? ` (exit ${exitCode})` : '';
  const stderrTrimmed = (stderr ?? '').trim();
  const sanitized = stderrTrimmed.slice(0, 500).replace(/```/g, "'''");

  const parts: string[] = [`⚠️ ${worker} failed${exitSuffix}.`];
  if (sanitized) parts.push(`\`\`\`\n${sanitized}\n\`\`\``);
  parts.push(suggestion);
  return parts.join('\n\n');
}
