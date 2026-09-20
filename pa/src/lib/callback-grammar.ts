/**
 * Single source of truth for the Telegram inline-button callback grammar and for
 * inline-keyboard validation — shared by the bot (which parses presses in
 * `projects/telegram-bot/src/callbacks.ts`) and by pa-side emitters (the
 * `[PA_KEYBOARD]:` envelope of `pa run` telegram_output, Python callers), which must
 * validate `callback_data` against the ONE grammar before sending (two producers of a
 * frozen grammar = drift — interactivity-audit §D, 2026-09-02).
 *
 * 2026-09-02 (topic-task handover Wave 1, the WAVE1 spec
 * §3.3–§3.4): the grammar moved here VERBATIM from the bot's callbacks.ts (which re-exports
 * `parseCallbackData`/`gateFor` + the types so every existing import keeps working), gained
 * the chat-gated `q:` prefix (the PA_META `question` action's option buttons), and gained
 * `validateKeyboardRequest`. The `reauth` row moved with it (`parseReauthCallback` +
 * `REAUTH_CALLBACK_PATTERN`, re-exported by the bot's logic.ts for its existing callers) —
 * the dependency direction is bot → pa, never the reverse.
 *
 * Callback grammar (≤64 bytes by construction; the parser returns null for anything
 * longer, malformed, or over-length in a field):
 *   reauth:google[:skill≤50]                       chat-gated
 *   cf:y | cf:n                                    chat-gated   (pending_action confirmation)
 *   cc:menu|agent|model|effort|back|new|stop|submit|discard  chat-gated   (control card navigation/actions)
 *   cc:set:agent:<≤16> | cc:set:model:<≤40> | cc:set:effort:<≤16>
 *   wf:retry | wf:switch:<worker≤16> | wf:revert:<worker≤16>
 *   pm:<auditId≤40>:approve|reject|diff            operator-gated
 *   dr:<name≤40>:approve|reject|show               operator-gated
 *   sk:run:<skill≤40>[:c] | sk:job:<job≤40>[:c]    operator-gated, two-step (:c = confirmed)
 *   rm:done | rm:1h | rm:tmrw                      chat-gated
 *   mc:<conflictId≤32>:a|r|x                       operator-gated
 *   rs:<chatId>:<threadId>:<updateId>              operator-gated (parsed with /^rs:(-?\d+):(\d+):(\d+)$/)
 *   dq:replay:<index≤4>[:c]                        operator-gated, two-step
 *   q:<0-3>                                        chat-gated   (PA_META question option —
 *                                                               index resolves against the
 *                                                               topic's pending_question)
 *   qt:<tt-12hex>:<0-3>                            chat-gated   (executor-lane task question
 *                                                               option — Wave 2; the taskId
 *                                                               resolves against the RUNNING
 *                                                               store, never state.turns)
 *   rq:<threadN>:<0-3>                             chat-gated   (executor-lane thread question
 *                                                               option — AI-203 WP-3; the
 *                                                               threadN resolves against the
 *                                                               topic's thread store, never
 *                                                               state.turns)
 *   ru:<ruleId≤40>:a|x                             operator-gated (weekly-digest rules
 *                                                               accept/reject — WP-D2 B.2)
 *   si:<family≤40>:m[:c]                           operator-gated, two-step (census-family
 *                                                               mute via fix record — WP-D2 B.5)
 *   ch:r:<chain≤40>[:c]                            operator-gated, two-step (chain-failure
 *                                                               re-run — WP-D2 B.6)
 *   wt:<watchId≤32>:r                              operator-gated (terminal-watch re-register
 *                                                               — WP-D2 B.7)
 *   ow:<gid12>:l|k|d                               operator-gated (orphan-edit disposition:
 *                                                               l=land as-is, k=keep dirty 24h,
 *                                                               d=show diff)
 *   sr:<idx>                                        chat-gated   (AI-234 quick-reply chip —
 *                                                               index resolves against the
 *                                                               topic's pending_suggestions)
 *   auth:<provider>:<ir-12hex>                     chat-gated   (auth broker Phase A —
 *                                                               open a pending request's
 *                                                               authorize link)
 * Conflict ids start with `cf-` (hyphen); the confirmation prefix is `cf:` (colon) —
 * anchored regexes, never startsWith.
 */

export type CallbackPrefix =
  | 'reauth'
  | 'auth'
  | 'cf'
  | 'cc'
  | 'wf'
  | 'pm'
  | 'dr'
  | 'sk'
  | 'rm'
  | 'mc'
  | 'rs'
  | 'dq'
  | 'q'
  | 'qt'
  | 'rq'
  | 'ru'
  | 'si'
  | 'ch'
  | 'wt'
  | 'ow'
  | 'sr';
export type CallbackGate = 'chat' | 'operator';

/** Parsed callback_data. `raw` is the original string. */
export type ParsedCallback =
  | { prefix: 'reauth'; provider: 'google'; skill?: string; raw: string }
  | { prefix: 'auth'; provider: string; requestId: string; raw: string }
  | { prefix: 'cf'; answer: 'y' | 'n'; raw: string }
  | { prefix: 'cc'; action: 'menu' | 'agent' | 'model' | 'effort' | 'back' | 'new' | 'stop' | 'submit' | 'discard'; raw: string }
  | { prefix: 'cc'; action: 'set'; setting: 'agent' | 'model' | 'effort'; value: string; raw: string }
  | { prefix: 'wf'; action: 'retry'; raw: string }
  | { prefix: 'wf'; action: 'switch' | 'revert'; worker: string; raw: string }
  | { prefix: 'pm'; auditId: string; action: 'approve' | 'reject' | 'diff'; raw: string }
  | { prefix: 'dr'; draft: string; action: 'approve' | 'reject' | 'show'; raw: string }
  | { prefix: 'sk'; kind: 'run' | 'job'; name: string; confirmed: boolean; raw: string }
  | { prefix: 'rm'; action: 'done' | '1h' | 'tmrw'; raw: string }
  | { prefix: 'mc'; conflictId: string; action: 'a' | 'r' | 'x'; raw: string }
  | { prefix: 'rs'; chatId: number; threadId: number; updateId: number; raw: string }
  | { prefix: 'dq'; index: number; confirmed: boolean; raw: string }
  | { prefix: 'q'; index: number; raw: string }
  | { prefix: 'qt'; taskId: string; index: number; raw: string }
  | { prefix: 'rq'; threadN: number; index: number; raw: string }
  | { prefix: 'ru'; ruleId: string; action: 'a' | 'x'; raw: string }
  | { prefix: 'si'; family: string; confirmed: boolean; raw: string }
  | { prefix: 'ch'; chain: string; confirmed: boolean; raw: string }
  | { prefix: 'wt'; watchId: string; raw: string }
  | { prefix: 'ow'; gid: string; action: 'l' | 'k' | 'd'; raw: string }
  | { prefix: 'sr'; index: number; raw: string };

// --- Grammar regexes (one per row; anchored; never startsWith) --------------------
// Callback-data contract for the inline "Re-authorize Google" button carried by every
// reauth notice (bot + Python sender share this shape): `reauth:google` or
// `reauth:google:<skill>` where `<skill>` matches [a-z0-9-]{1,50}.
// `reauth:google:` is 14 bytes, so 50 is the largest suffix that fits Telegram's
// 64-byte `callback_data` limit.
export const REAUTH_CALLBACK_PATTERN = /^reauth:(google)(?::([a-z0-9-]{1,50}))?$/;
// auth: — auth broker Phase A (2026-09-10 build spec §3.9): opens a pending broker
// request's authorize link. `auth:` + provider (1-16 chars) + `:` + `ir-` + 12 hex is
// 5 + 16 + 1 + 15 = 37 bytes max, inside the 64-byte cap.
export const AUTH_CALLBACK_PATTERN = /^auth:([a-z0-9][a-z0-9-]{0,15}):(ir-[0-9a-f]{12})$/;
const CF_RE = /^cf:(y|n)$/;
const CC_SIMPLE_RE = /^cc:(menu|agent|model|effort|back|new|stop|submit|discard)$/;
const CC_SET_RE = /^cc:set:(agent|model|effort):([\s\S]{1,64})$/;
export const CC_SET_CAPS: Record<'agent' | 'model' | 'effort', number> = { agent: 16, model: 40, effort: 16 };
const WF_RETRY_RE = /^wf:retry$/;
const WF_WORKER_RE = /^wf:(switch|revert):([A-Za-z0-9_-]{1,16})$/;
// auditId is often an ISO timestamp (colons and all) — the group is greedy-with-
// backtrack, so it still resolves correctly against the fixed action alternation at
// the end regardless of colons inside the id (unlike main.ts's old `[^:]+` regex,
// which could never match a colon-bearing id — this parser supersedes that regex).
const PM_RE = /^pm:([\s\S]{1,40}):(approve|reject|diff)$/;
const DR_RE = /^dr:([A-Za-z0-9_-]{1,40}):(approve|reject|show)$/;
export const SK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SK_RE = /^sk:(run|job):([a-z0-9][a-z0-9-]{0,39})(:c)?$/;
const RM_RE = /^rm:(done|1h|tmrw)$/;
const MC_RE = /^mc:([A-Za-z0-9-]{1,32}):(a|r|x)$/;
const RS_RE = /^rs:(-?\d+):(\d+):(\d+)$/;
const DQ_RE = /^dq:replay:(\d{1,4})(:c)?$/;
// q: option index — exactly one digit 0..3 (options are capped at 4; a 4th digit or
// any other shape falls through to null).
const Q_RE = /^q:([0-3])$/;
// qt: (Wave 2) — task-question press: `qt:` + a full task id (tt- + 12 hex, the
// TopicTask id grammar) + the option index. "qt:" + id + ":" + digit is 20 bytes.
// Chat-gated like q: (a task question is answered by whoever may speak in the chat).
export const QT_RE = /^qt:(tt-[0-9a-f]{12}):([0-3])$/;
// rq: (AI-203 WP-3) — thread-question press: `rq:` + the thread's numeric `n`
// (the ThreadRecord.n that WP-2's buildThreadQuestionKeyboard stamps on the
// button) + the option index 0..3. "rq:" + n + ":" + digit is ≤64 bytes by
// construction (n is a small per-topic counter). Chat-gated like q:/qt: (a
// thread question is answered by whoever may speak in the chat). The handler
// converts `t-<n>` and calls takePendingQuestion against the topic's thread
// store — never state.turns.
export const RQ_RE = /^rq:(\d+):([0-3])$/;
// sr: (AI-234) — quick-reply chip press: `sr:` + the chip's numeric index. The
// index resolves against the topic's ephemeral pending_suggestions.items[idx]
// (set by main.ts when the orchestrator's suggested_items survive sanitize).
// Chat-gated like q: (a chip reply is typed by whoever may speak in the chat).
// The chip label rides the button text, NOT callback_data — the press carries
// only the tiny index, so the 64-byte Bot API limit is never the binding constraint.
const SR_RE = /^sr:(\d+)$/;

// --- WP-D2 prefixes (Wave 2 Phase 2, SPEC §3.4) — pa-side emitters only; the bot's
// callbacks.ts gains the four handlers against these same regexes (one-parser rule).
// ru: (B.2) — rules accept/reject from the weekly digest. ruleId is the pa rules
// store's id charset; the digest emits a button ONLY for ids it has charset-checked.
export const RU_RE = /^ru:([A-Za-z0-9_-]{1,40}):(a|x)$/;
// si: (B.5) — mute a census alert family via a fix record, from the nightly report.
// Two-step like sk:/dq:. Family keys are alert-census normalized keys.
export const SI_RE = /^si:([A-Za-z0-9._-]{1,40}):m(:c)?$/;
// ch: (B.6) — re-run a failed chain. Two-step like sk:/dq:. The SPEC's original CH_RE
// (no `(:c)?` group) could not parse its own two-tap keyboard data `ch:r:<name>:c`;
// the optional confirm group follows the sk:/dq: precedent. Chain names match the
// chains store's name charset (SK_NAME_RE).
export const CH_RE = /^ch:r:([a-z0-9][a-z0-9-]{0,39})(:c)?$/;
// wt: (B.7) — re-register a terminal watch from its failure/expiry report.
export const WT_RE = /^wt:([a-z0-9-]{1,32}):r$/;
// ow: — operator-gated orphan-edit disposition (AI-214): `ow:` + a 12-hex gid
// (the emitter hashes to exactly 12, so the guard is the same on both ends —
// mc: precedent) + one action letter. `ow:` + 12 + `:` + 1 = 18 bytes ≤ 64.
export const OW_RE = /^ow:([0-9a-f]{12}):(l|k|d)$/;

/**
 * Parses the `reauth:google[:skill]` inline-button callback_data. Pure — no I/O.
 * (Moved 2026-09-02 from the bot's logic.ts, which re-exports this for its existing
 * callers; the actual link request is executed by the bot's main.ts via spawnReauthLink.)
 */
export function parseReauthCallback(data: string | undefined): { provider: 'google'; skill?: string } | null {
  if (!data) return null;
  const m = REAUTH_CALLBACK_PATTERN.exec(data);
  if (!m) return null;
  return { provider: 'google', skill: m[2] };
}

/** Pure. Returns null for anything unrecognised or over 64 bytes. Every form in the
 *  grammar is ASCII, so `.length` and byte length coincide. */
export function parseCallbackData(data: string | undefined): ParsedCallback | null {
  if (!data || data.length > 64) return null;

  const reauth = parseReauthCallback(data);
  if (reauth) return { prefix: 'reauth', ...reauth, raw: data };

  const authMatch = AUTH_CALLBACK_PATTERN.exec(data);
  if (authMatch) return { prefix: 'auth', provider: authMatch[1], requestId: authMatch[2], raw: data };

  let m: RegExpExecArray | null;

  if ((m = CF_RE.exec(data))) return { prefix: 'cf', answer: m[1] as 'y' | 'n', raw: data };

  if (WF_RETRY_RE.test(data)) return { prefix: 'wf', action: 'retry', raw: data };
  if ((m = WF_WORKER_RE.exec(data))) {
    return { prefix: 'wf', action: m[1] as 'switch' | 'revert', worker: m[2], raw: data };
  }

  if ((m = CC_SET_RE.exec(data))) {
    const setting = m[1] as 'agent' | 'model' | 'effort';
    const value = m[2];
    if (value.length === 0 || value.length > CC_SET_CAPS[setting]) return null;
    return { prefix: 'cc', action: 'set', setting, value, raw: data };
  }
  if ((m = CC_SIMPLE_RE.exec(data))) {
    return {
      prefix: 'cc',
      action: m[1] as 'menu' | 'agent' | 'model' | 'effort' | 'back' | 'new' | 'stop' | 'submit' | 'discard',
      raw: data,
    };
  }

  if ((m = PM_RE.exec(data))) {
    return { prefix: 'pm', auditId: m[1], action: m[2] as 'approve' | 'reject' | 'diff', raw: data };
  }
  if ((m = DR_RE.exec(data))) {
    return { prefix: 'dr', draft: m[1], action: m[2] as 'approve' | 'reject' | 'show', raw: data };
  }
  if ((m = SK_RE.exec(data))) {
    return { prefix: 'sk', kind: m[1] as 'run' | 'job', name: m[2], confirmed: !!m[3], raw: data };
  }
  if ((m = RM_RE.exec(data))) return { prefix: 'rm', action: m[1] as 'done' | '1h' | 'tmrw', raw: data };
  if ((m = MC_RE.exec(data))) {
    return { prefix: 'mc', conflictId: m[1], action: m[2] as 'a' | 'r' | 'x', raw: data };
  }
  if ((m = RS_RE.exec(data))) {
    return { prefix: 'rs', chatId: Number(m[1]), threadId: Number(m[2]), updateId: Number(m[3]), raw: data };
  }
  if ((m = DQ_RE.exec(data))) return { prefix: 'dq', index: Number(m[1]), confirmed: !!m[2], raw: data };
  if ((m = Q_RE.exec(data))) return { prefix: 'q', index: Number(m[1]), raw: data };
  if ((m = QT_RE.exec(data))) return { prefix: 'qt', taskId: m[1], index: Number(m[2]), raw: data };
  if ((m = RQ_RE.exec(data))) return { prefix: 'rq', threadN: Number(m[1]), index: Number(m[2]), raw: data };
  if ((m = RU_RE.exec(data))) return { prefix: 'ru', ruleId: m[1], action: m[2] as 'a' | 'x', raw: data };
  if ((m = SI_RE.exec(data))) return { prefix: 'si', family: m[1], confirmed: !!m[2], raw: data };
  if ((m = CH_RE.exec(data))) return { prefix: 'ch', chain: m[1], confirmed: !!m[2], raw: data };
  if ((m = WT_RE.exec(data))) return { prefix: 'wt', watchId: m[1], raw: data };
  if ((m = OW_RE.exec(data))) {
    return { prefix: 'ow', gid: m[1], action: m[2] as 'l' | 'k' | 'd', raw: data };
  }
  if ((m = SR_RE.exec(data))) return { prefix: 'sr', index: Number(m[1]), raw: data };

  return null;
}

const OPERATOR_PREFIXES = new Set<CallbackPrefix>(['pm', 'dr', 'sk', 'mc', 'rs', 'dq', 'ru', 'si', 'ch', 'wt', 'ow']);

/** Pure. Which gate class a parsed callback needs (§3.3). */
export function gateFor(parsed: ParsedCallback): CallbackGate {
  return OPERATOR_PREFIXES.has(parsed.prefix) ? 'operator' : 'chat';
}

// --- Keyboard request validation (pa-side emitters; SPEC §3.4) --------------------
// One validation shape for every producer that attaches an inline keyboard outside the
// bot's own builders (the `[PA_KEYBOARD]:` envelope of `pa run` telegram_output): a
// grammar-checked, capped request, never trusted free-form.

export interface KeyboardButton {
  text: string;
  callback_data: string;
}

export type ValidatedKeyboard =
  | { ok: true; keyboard: { inline_keyboard: KeyboardButton[][] } }
  | { ok: false; error: string };

/** Validates a keyboard request and builds its Telegram `inline_keyboard` (one button
 *  per row). Ok iff: `buttons` is an array of 1..6 entries, each entry is an object with
 *  EXACTLY the `text` and `callback_data` keys, `text` is 1..40 chars, and
 *  `parseCallbackData(callback_data)` accepts the data string (which also enforces the
 *  64-byte budget). Pure; never throws on hostile input. */
export function validateKeyboardRequest(input: unknown): ValidatedKeyboard {
  const buttons = (input as { buttons?: unknown } | null | undefined)?.buttons;
  if (!Array.isArray(buttons) || buttons.length < 1 || buttons.length > 6) {
    return { ok: false, error: 'buttons must be an array of 1..6 buttons' };
  }
  const rows: KeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i] as Record<string, unknown> | null | undefined;
    if (typeof b !== 'object' || b === null || Array.isArray(b)) {
      return { ok: false, error: `button ${i}: must be an object` };
    }
    const keys = Object.keys(b).sort();
    if (keys.length !== 2 || keys[0] !== 'callback_data' || keys[1] !== 'text') {
      return { ok: false, error: `button ${i}: must have exactly text and callback_data` };
    }
    const text = b['text'];
    const data = b['callback_data'];
    if (typeof text !== 'string' || text.length < 1 || text.length > 40) {
      return { ok: false, error: `button ${i}: text must be 1..40 chars` };
    }
    if (typeof data !== 'string' || parseCallbackData(data) === null) {
      return { ok: false, error: `button ${i}: callback_data does not match the callback grammar` };
    }
    rows.push([{ text, callback_data: data }]);
  }
  return { ok: true, keyboard: { inline_keyboard: rows } };
}
