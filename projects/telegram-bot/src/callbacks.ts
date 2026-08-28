/**
 * Inline-button callback surface (2026-08-24 buttons program,
 * plans/2026-08-24-buttons-program-SPEC.md §3.1–§3.3, P6, WP-B0).
 *
 * WP-B0 fills the P6 skeleton. WP-B1 wires `handleCallbackQuery` / `handleMessageReaction`
 * into `runPollLoop` and supplies the `CallbackDeps` (including `injectUpdate`, the seam
 * that makes "a button is a typed command" literally true — a press that maps to a
 * command becomes a synthetic TelegramUpdate pushed into the next poll batch, never a
 * second code path).
 *
 * Callback grammar (spec §3.2, ≤64 bytes by construction; the parser returns null for
 * anything longer, malformed, or over-length in a field):
 *   reauth:google[:skill≤50]                       chat-gated
 *   cf:y | cf:n                                    chat-gated   (pending_action confirmation)
 *   cc:menu|agent|model|effort|back|new|stop|ka    chat-gated   (control card navigation/actions)
 *   cc:set:agent:<≤16> | cc:set:model:<≤40> | cc:set:effort:<≤16>
 *   wf:retry | wf:switch:<worker≤16> | wf:revert:<worker≤16>
 *   pm:<auditId≤40>:approve|reject|diff            operator-gated
 *   dr:<name≤40>:approve|reject|show               operator-gated
 *   sk:run:<skill≤40>[:c] | sk:job:<job≤40>[:c]    operator-gated, two-step (:c = confirmed)
 *   rm:done | rm:1h | rm:tmrw                      chat-gated
 *   mc:<conflictId≤32>:a|r|x                       operator-gated
 *   rs:<chatId>:<threadId>:<updateId>              operator-gated (parsed with /^rs:(-?\d+):(\d+):(\d+)$/)
 *   dq:replay:<index≤4>[:c]                        operator-gated, two-step
 * Conflict ids start with `cf-` (hyphen); the confirmation prefix is `cf:` (colon) —
 * anchored regexes, never startsWith.
 */

import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import type { InlineKeyboardMarkup, InlineKeyboardButton } from './telegram.js';
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
  setMessageReaction,
  editMessageText,
  sanitizeMdV2,
} from './telegram.js';
import type { ConversationState, TelegramUpdate, MessageReactionUpdated, CallbackQuery } from './types.js';
import { PA_META_PROTECTED_SKILLS, parseReauthCallback } from './logic.js';
import { appendRefIdAndLog, makeRefId } from './ref-id.js';
import { resendKey, takeResend } from './resend-store.js';
import { isBarePlaceholderUserText } from './voice.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import { toIST, IST_OFFSET_MS } from '../../../pa/dist/src/ist.js';
import { listSkills } from '../../../pa/dist/src/skills.js';
import { loadDraft } from '../../../pa/dist/src/drafts.js';
import { findJob } from '../../../pa/dist/src/lib/maintenance/registry.js';
import { recordDecision, recordReaction } from '../../../pa/dist/src/lib/decisions.js';
import { dlqReplayCommand } from '../../../pa/dist/src/commands/dlq.js';
import { KNOWN_CLI_DEFAULT_MODELS, KNOWN_CLI_DEFAULT_EFFORTS } from '../../../pa/dist/src/lib/tunables.js';

export type CallbackPrefix = 'reauth' | 'cf' | 'cc' | 'wf' | 'pm' | 'dr' | 'sk' | 'rm' | 'mc' | 'rs' | 'dq';
export type CallbackGate = 'chat' | 'operator';

/** Parsed callback_data. `raw` is the original string. */
export type ParsedCallback =
  | { prefix: 'reauth'; provider: 'google'; skill?: string; raw: string }
  | { prefix: 'cf'; answer: 'y' | 'n'; raw: string }
  | { prefix: 'cc'; action: 'menu' | 'agent' | 'model' | 'effort' | 'back' | 'new' | 'stop' | 'ka'; raw: string }
  | { prefix: 'cc'; action: 'set'; setting: 'agent' | 'model' | 'effort'; value: string; raw: string }
  | { prefix: 'wf'; action: 'retry'; raw: string }
  | { prefix: 'wf'; action: 'switch' | 'revert'; worker: string; raw: string }
  | { prefix: 'pm'; auditId: string; action: 'approve' | 'reject' | 'diff'; raw: string }
  | { prefix: 'dr'; draft: string; action: 'approve' | 'reject' | 'show'; raw: string }
  | { prefix: 'sk'; kind: 'run' | 'job'; name: string; confirmed: boolean; raw: string }
  | { prefix: 'rm'; action: 'done' | '1h' | 'tmrw'; raw: string }
  | { prefix: 'mc'; conflictId: string; action: 'a' | 'r' | 'x'; raw: string }
  | { prefix: 'rs'; chatId: number; threadId: number; updateId: number; raw: string }
  | { prefix: 'dq'; index: number; confirmed: boolean; raw: string };

// --- Grammar regexes (one per §3.2 row; anchored; never startsWith) --------------
const CF_RE = /^cf:(y|n)$/;
const CC_SIMPLE_RE = /^cc:(menu|agent|model|effort|back|new|stop|ka)$/;
const CC_SET_RE = /^cc:set:(agent|model|effort):([\s\S]{1,64})$/;
const CC_SET_CAPS: Record<'agent' | 'model' | 'effort', number> = { agent: 16, model: 40, effort: 16 };
const WF_RETRY_RE = /^wf:retry$/;
const WF_WORKER_RE = /^wf:(switch|revert):([A-Za-z0-9_-]{1,16})$/;
// auditId is often an ISO timestamp (colons and all) — the group is greedy-with-
// backtrack, so it still resolves correctly against the fixed action alternation at
// the end regardless of colons inside the id (unlike main.ts's old `[^:]+` regex,
// which could never match a colon-bearing id — this parser supersedes that regex).
const PM_RE = /^pm:([\s\S]{1,40}):(approve|reject|diff)$/;
const DR_RE = /^dr:([A-Za-z0-9_-]{1,40}):(approve|reject|show)$/;
const SK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SK_RE = /^sk:(run|job):([a-z0-9][a-z0-9-]{0,39})(:c)?$/;
const RM_RE = /^rm:(done|1h|tmrw)$/;
const MC_RE = /^mc:([A-Za-z0-9-]{1,32}):(a|r|x)$/;
const RS_RE = /^rs:(-?\d+):(\d+):(\d+)$/;
const DQ_RE = /^dq:replay:(\d{1,4})(:c)?$/;

/** Pure. Returns null for anything unrecognised or over 64 bytes. Every form in the
 *  grammar is ASCII, so `.length` and byte length coincide. */
export function parseCallbackData(data: string | undefined): ParsedCallback | null {
  if (!data || data.length > 64) return null;

  const reauth = parseReauthCallback(data);
  if (reauth) return { prefix: 'reauth', ...reauth, raw: data };

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
      action: m[1] as 'menu' | 'agent' | 'model' | 'effort' | 'back' | 'new' | 'stop' | 'ka',
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

  return null;
}

const OPERATOR_PREFIXES = new Set<CallbackPrefix>(['pm', 'dr', 'sk', 'mc', 'rs', 'dq']);

/** Pure. Which gate class a parsed callback needs (§3.3). */
export function gateFor(parsed: ParsedCallback): CallbackGate {
  return OPERATOR_PREFIXES.has(parsed.prefix) ? 'operator' : 'chat';
}

// --- Pure keyboard builders -------------------------------------------------------

export function buildConfirmKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Yes', callback_data: 'cf:y' },
        { text: '❌ No', callback_data: 'cf:n' },
      ],
    ],
  };
}

export function buildControlCardKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Agent ▸', callback_data: 'cc:agent' },
        { text: 'Model ▸', callback_data: 'cc:model' },
        { text: 'Effort ▸', callback_data: 'cc:effort' },
      ],
      [
        { text: '🆕 New', callback_data: 'cc:new' },
        { text: '⏹ Stop', callback_data: 'cc:stop' },
        { text: '☕ Keep-awake', callback_data: 'cc:ka' },
      ],
    ],
  };
}

const BACK_ROW: InlineKeyboardButton[] = [{ text: '◀ Back', callback_data: 'cc:back' }];

export function buildAgentPickerKeyboard(workers: string[], current: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  for (const worker of workers) {
    const data = `cc:set:agent:${worker}`;
    if (data.length > 64 || worker.length > CC_SET_CAPS.agent) continue;
    const label = worker === current ? `• ${worker}` : worker;
    rows.push([{ text: label, callback_data: data }]);
  }
  rows.push(BACK_ROW);
  return { inline_keyboard: rows };
}

export function buildValuePickerKeyboard(
  setting: 'model' | 'effort',
  values: string[],
  current?: string
): InlineKeyboardMarkup {
  const cap = CC_SET_CAPS[setting];
  const buttons: InlineKeyboardButton[] = [];
  for (const value of values) {
    const data = `cc:set:${setting}:${value}`;
    if (value.length === 0 || value.length > cap || data.length > 64) continue;
    const label = value === current ? `• ${value}` : value;
    buttons.push({ text: label, callback_data: data });
  }
  // A declared value list (e.g. agy's 11 models) makes a 1-per-row keyboard too tall for
  // a phone screen — lay out 2 per row once there are more than 6 surviving buttons.
  const perRow = buttons.length > 6 ? 2 : 1;
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  rows.push(BACK_ROW);
  return { inline_keyboard: rows };
}

export function buildFailoverKeyboard(args: { next?: string; previous?: string }): InlineKeyboardMarkup | undefined {
  const row: InlineKeyboardButton[] = [{ text: '🔁 Retry', callback_data: 'wf:retry' }];
  if (args.next && args.next.length <= 16) {
    row.push({ text: `↔ Switch to ${args.next}`, callback_data: `wf:switch:${args.next}` });
  }
  if (args.previous && args.previous.length <= 16) {
    row.push({ text: `↩ Revert to ${args.previous}`, callback_data: `wf:revert:${args.previous}` });
  }
  return { inline_keyboard: [row] };
}

export function buildRunNowKeyboard(
  kind: 'run' | 'job',
  name: string,
  confirmed: boolean
): InlineKeyboardMarkup | undefined {
  if (!SK_NAME_RE.test(name)) return undefined;
  if (kind === 'run' && PA_META_PROTECTED_SKILLS.has(name)) return undefined;

  if (!confirmed) {
    return { inline_keyboard: [[{ text: '▶ Run now', callback_data: `sk:${kind}:${name}` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: `⚠️ Confirm ${name}`, callback_data: `sk:${kind}:${name}:c` },
        { text: 'Cancel', callback_data: 'cc:back' },
      ],
    ],
  };
}

export function buildReminderKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: '✅ Done', callback_data: 'rm:done' },
        { text: '💤 1 h', callback_data: 'rm:1h' },
        { text: '🌅 Tomorrow', callback_data: 'rm:tmrw' },
      ],
    ],
  };
}

export function buildResendKeyboard(chatId: number, threadId: number, updateId: number): InlineKeyboardMarkup | undefined {
  const data = `rs:${chatId}:${threadId}:${updateId}`;
  if (data.length > 64) return undefined;
  return { inline_keyboard: [[{ text: '🔁 Resend', callback_data: data }]] };
}

export function buildDlqReplayKeyboard(index: number, confirmed: boolean): InlineKeyboardMarkup | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 9999) return undefined;
  if (!confirmed) {
    return { inline_keyboard: [[{ text: '▶ Replay', callback_data: `dq:replay:${index}` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: '⚠️ Confirm replay', callback_data: `dq:replay:${index}:c` },
        { text: 'Cancel', callback_data: 'cc:back' },
      ],
    ],
  };
}

/** Pure. The text a press is equivalent to typing, or null when the press is not a
 *  synthetic-message action (menu navigation, approvals handled in-process), or when it
 *  synthesizes but needs an async lookup this pure function cannot do (`wf:retry`,
 *  `rs:`) — those two are built directly by handleCallbackQuery instead. */
export function syntheticTextFor(parsed: ParsedCallback): string | null {
  switch (parsed.prefix) {
    case 'cf':
      return parsed.answer === 'y' ? 'yes' : 'no';
    case 'cc':
      if (parsed.action === 'set') {
        if (parsed.setting === 'agent') return `/agent ${parsed.value}`;
        if (parsed.setting === 'model') return `/model ${parsed.value}`;
        return `/effort ${parsed.value}`;
      }
      if (parsed.action === 'new') return '/new';
      if (parsed.action === 'stop') return '/stop';
      if (parsed.action === 'ka') return '/keepawake';
      return null; // menu, agent, model, effort, back — handled in-process
    case 'wf':
      if (parsed.action === 'switch' || parsed.action === 'revert') return `/agent ${parsed.worker}`;
      return null; // 'retry' needs the topic's last user turn — async, see handleCallbackQuery
    default:
      return null; // reauth, pm, dr, sk, rm, mc, rs, dq — handled in-process
  }
}

/** Pure. Builds the injected update. `updateId` MUST come from nextSyntheticUpdateId(). */
export function buildSyntheticUpdate(args: {
  updateId: number;
  chatId: number;
  threadId: number;
  messageId: number;
  from: { id: number; first_name: string; username?: string };
  text: string;
  via: 'button' | 'reaction';
}): TelegramUpdate & { __synthetic: 'button' | 'reaction' } {
  return {
    update_id: args.updateId,
    message: {
      message_id: args.messageId,
      from: args.from,
      chat: { id: args.chatId, type: args.threadId ? 'supergroup' : 'private' },
      date: Math.floor(Date.now() / 1000),
      text: args.text,
      ...(args.threadId ? { message_thread_id: args.threadId } : {}),
    },
    __synthetic: args.via,
  };
}

let lastIssuedSyntheticUpdateId = 0;

/** Monotonic, always ABOVE any real Telegram update_id, unique per call. */
export function nextSyntheticUpdateId(now?: number): number {
  const base = now ?? Date.now();
  const id = Math.max(base, lastIssuedSyntheticUpdateId + 1);
  lastIssuedSyntheticUpdateId = id;
  return id;
}

// bp-retry (2026-08-25): main.ts's refreshPinnedStatusCardInPlace is driven by a
// periodic cross-topic sweep and unconditionally rewrites the pinned status card back
// to buildControlCardKeyboard() (the top-level menu) — the SAME message id that
// cc:agent/cc:model/cc:effort edit in place to show a submenu. A sweep tick landing
// between a submenu press and the user's next tap silently reverted the card, so a tap
// aimed at a model option could hit an unrelated top-level control instead. This index
// records which submenu keyboard is currently displayed per `${chatId}:${messageId}`,
// with a timestamp; refreshPinnedStatusCardInPlace consults it via currentCardKeyboard
// and re-applies the submenu instead of the top-level menu while it's fresh. Mirrors
// confirmThreadIndex above: in-memory, bounded, insertion-order eviction.
const CARD_KEYBOARD_INDEX_MAX = 200;
const CARD_KEYBOARD_FRESH_MS = 2 * 60 * 1000;
const cardKeyboardIndex = new Map<string, { keyboard: InlineKeyboardMarkup; recordedAt: number }>();

function cardKeyboardKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Records the submenu keyboard now displayed on a control-card message. Call this
 *  wherever a cc:agent/cc:model/cc:effort press renders a submenu in place. */
function recordCardKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboardMarkup, now: number = Date.now()): void {
  const key = cardKeyboardKey(chatId, messageId);
  cardKeyboardIndex.delete(key); // re-inserting moves it to the end (most-recent)
  cardKeyboardIndex.set(key, { keyboard, recordedAt: now });
  while (cardKeyboardIndex.size > CARD_KEYBOARD_INDEX_MAX) {
    const oldestKey = cardKeyboardIndex.keys().next().value;
    if (oldestKey === undefined) break;
    cardKeyboardIndex.delete(oldestKey);
  }
}

/** Clears any recorded submenu for a control-card message — call on cc:menu/cc:back
 *  (returns to the top-level menu), on any cc:set: (the press is complete), and from
 *  main.ts's replacePinnedStatusCard for the SUPERSEDED card id (its entry can never be
 *  reached again — Telegram never reuses a message id — so it would sit dead in the map). */
export function clearCardKeyboard(chatId: number, messageId: number): void {
  cardKeyboardIndex.delete(cardKeyboardKey(chatId, messageId));
}

/** Returns the submenu keyboard currently displayed on this control-card message, if
 *  one was recorded within the last CARD_KEYBOARD_FRESH_MS — else undefined (meaning:
 *  show the top-level buildControlCardKeyboard()). `now` is injectable for tests. */
export function currentCardKeyboard(chatId: number, messageId: number, now: number = Date.now()): InlineKeyboardMarkup | undefined {
  const entry = cardKeyboardIndex.get(cardKeyboardKey(chatId, messageId));
  if (!entry) return undefined;
  if (now - entry.recordedAt > CARD_KEYBOARD_FRESH_MS) return undefined;
  return entry.keyboard;
}

export interface CallbackDeps {
  token: string;
  secrets: Record<string, string>;
  runtimeEnv: NodeJS.ProcessEnv;
  botCwd: string;
  /** Push a synthetic update into the poll batch (WP-B1 wiring). */
  injectUpdate: (update: TelegramUpdate) => void;
  /** main.ts helpers, injected to avoid an import cycle. */
  spawnReauthLink: (chatId: number, threadId: number | undefined, env: NodeJS.ProcessEnv, skill?: string) => string;
  loadTopicState: (chatId: number, threadId: number) => Promise<ConversationState>;
  listWorkerNames: () => Promise<string[]>;
  observedValues: (worker: string, setting: 'model' | 'effort') => Promise<string[]>;
  /** Authoritative config.yaml `tunables.<setting>.values` for the worker — see
   *  `declaredValues`/`getTunableSpec` in pa/src/lib/tunables.ts. Same source the typed
   *  `/model`/`/effort` commands use (logic.ts's renderTunableReport). */
  declaredValues: (worker: string, setting: 'model' | 'effort') => Promise<string[]>;
  /** bp-retry (2026-08-25): the canonical topic-default worker (main.ts's
   *  `getEffectiveDefaultWorker(config, topicKey)`, the same value
   *  `handleTunableCommand`'s `state.preferred_worker || effectiveDefault` cascade
   *  resolves to for the typed `/model`/`/effort` commands). The FINAL fallback for
   *  `cc:agent`/`cc:model`/`cc:effort` when a topic has neither `preferred_worker` nor
   *  a hydrated `model_status` yet — must never be left to resolve to ''. */
  effectiveDefaultWorker: (chatId: number, threadId: number) => Promise<string>;
}

const SPAWN_OPTS = { detached: true, stdio: 'ignore' as const, shell: true, windowsHide: true };

// Node's built-in child_process.spawn is a non-configurable export — node:test's
// mock.method() cannot redefine it, so every spawn call in this file goes through this
// indirection instead, giving tests a seam (same idea as resend-store.ts's
// _resetResendStoreForTest — a test-only override hook, never used in production).
let spawnImpl: typeof spawn = spawn;
/** Test hook: override the spawn implementation so a unit test never launches a real
 *  process. Never called in production. */
export function _setSpawnForTest(fn: typeof spawn): void {
  spawnImpl = fn;
}
/** Test hook: restore the real spawn implementation. */
export function _restoreSpawnForTest(): void {
  spawnImpl = spawn;
}

function tomorrowNineAmIST(now: Date = new Date()): string {
  const ist = toIST(now);
  const tomorrowIstWallClock = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 9, 0, 0, 0);
  return new Date(tomorrowIstWallClock - IST_OFFSET_MS).toISOString();
}

const REMINDER_PREFIX_RE = /^⏰\s*\*?Reminder:\*?\s*/;
const REMINDER_REF_SUFFIX_RE = /\n\n_?Ref:\s*\S+_?\s*$/;

/** Strips the fixed "⏰ *Reminder:* " prefix and the "Ref: <id>" trailer (both the
 *  Markdown-rendered and plain-text-fallback forms) from a reminder notice's delivered
 *  text, leaving the original reminder message (§3.4). */
function extractReminderMessage(text: string): string {
  return text.replace(REMINDER_PREFIX_RE, '').replace(REMINDER_REF_SUFFIX_RE, '').trim();
}

interface DlqEntrySlim {
  refId?: string;
  quarantined?: boolean;
}

/** Minimal read of the DLQ file for the `dq:` re-validation step — `pa/src/commands/dlq.ts`
 *  does not export its internal loadDlq(), and this wave does not own that file. */
async function readDlqEntriesSlim(): Promise<DlqEntrySlim[]> {
  try {
    const raw = await readFile(join(paHome(), 'telegram-dlq.jsonl'), 'utf8');
    return raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DlqEntrySlim);
  } catch {
    return [];
  }
}

/** Appends a selection acknowledgment to the button-bearing message's existing text
 *  and strips its keyboard in the same edit. NEVER throws — all errors are logged
 *  and swallowed so handleCallbackQuery keeps its never-throws contract. */
async function ackSelection(deps: CallbackDeps, cb: CallbackQuery, label: string): Promise<void> {
  try {
    const chatId = cb.message?.chat.id;
    const threadId = cb.message?.message_thread_id ?? 0;
    const messageId = cb.message?.message_id;
    if (messageId === undefined || chatId === undefined) return;

    const base = cb.message?.text ?? '';
    const ist = toIST(new Date());
    const hh = String(ist.getUTCHours()).padStart(2, '0');
    const mm = String(ist.getUTCMinutes()).padStart(2, '0');
    const ackLine = `✅ Selected: ${label} · ${hh}:${mm} IST`;
    const sanitizedAckLine = sanitizeMdV2(ackLine);

    let full: string;
    if (base.length > 0) {
      const capped = base.length > 3800 ? base.slice(0, 3800) + '…' : base;
      full = capped + '\n\n' + sanitizedAckLine;
    } else {
      full = sanitizedAckLine;
    }

    const success = await editMessageText(deps.token, chatId, messageId, full, undefined, { rawMarkdown: true });
    if (!success) {
      // Fallback: edit failed (message older than 48h, entity mismatch, network, etc.)
      await editMessageReplyMarkup(deps.token, chatId, messageId, undefined);
      await sendMessage(deps.token, chatId, `✅ Selected: ${label}`, messageId, threadId || undefined);
    }
  } catch (err) {
    logger.warn('callback', `ackSelection error: ${(err as Error).message}`, { label });
  }
}

/** Handles one callback_query end to end. Never throws. Returns a short outcome
 *  string for the log line. Answers the callback FIRST, then acts (design rule 2). */
export async function handleCallbackQuery(cb: CallbackQuery, deps: CallbackDeps): Promise<string> {
  const chatId = cb.message?.chat.id ?? 0;
  const threadId = cb.message?.message_thread_id ?? 0;
  const messageId = cb.message?.message_id;
  const userId = cb.from?.id?.toString();

  try {
    const parsed = parseCallbackData(cb.data);
    if (!parsed) {
      await answerCallbackQuery(deps.token, cb.id, 'Unknown button');
      return 'unparsed';
    }

    const operatorId = deps.secrets['PA_OPERATOR_USER_ID'];
    const gate = gateFor(parsed);
    if (gate === 'operator') {
      if (!operatorId) {
        await answerCallbackQuery(deps.token, cb.id, 'Set PA_OPERATOR_USER_ID to enable this button', true);
        return 'no-operator-id';
      }
      if (userId !== operatorId) {
        await answerCallbackQuery(deps.token, cb.id, 'Only the configured operator can do this', true);
        return 'unauthorized';
      }
    } else if (operatorId && userId !== operatorId) {
      // Chat-gated actions are confined to allowedChatIds (already checked by the
      // caller); PA_OPERATOR_USER_ID is an OPTIONAL extra check when set (§3.3), never
      // a hard requirement — unset, every chat member may press these buttons.
      await answerCallbackQuery(deps.token, cb.id, 'This chat has an operator set — only they can use this button', true);
      return 'chat-gate-operator-mismatch';
    }

    switch (parsed.prefix) {
      case 'reauth': {
        const text = deps.spawnReauthLink(chatId, threadId || undefined, deps.runtimeEnv, parsed.skill);
        await answerCallbackQuery(deps.token, cb.id, '🔐 Minting a fresh Google link…');
        if (messageId) await ackSelection(deps, cb, parsed.skill ? `Reauth Google (${parsed.skill})` : 'Reauth Google');
        await sendMessage(
          deps.token,
          chatId,
          appendRefIdAndLog(text, { kind: 'callback', chatId, threadId }),
          undefined,
          threadId || undefined
        );
        return 'reauth';
      }

      case 'cf': {
        const text = syntheticTextFor(parsed)!;
        await answerCallbackQuery(deps.token, cb.id, parsed.answer === 'y' ? '✅ Confirmed' : '❌ Cancelled');
        if (messageId) await ackSelection(deps, cb, parsed.answer === 'y' ? 'Yes' : 'No');
        deps.injectUpdate(
          buildSyntheticUpdate({
            updateId: nextSyntheticUpdateId(),
            chatId,
            threadId,
            messageId: messageId ?? 0,
            from: cb.from,
            text,
            via: 'button',
          })
        );
        return `cf:${parsed.answer}`;
      }

      case 'cc': {
        if (parsed.action === 'menu' || parsed.action === 'back') {
          await answerCallbackQuery(deps.token, cb.id);
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, buildControlCardKeyboard());
            clearCardKeyboard(chatId, messageId); // back to the top-level menu — no submenu to protect anymore
          }
          return `cc:${parsed.action}`;
        }
        if (parsed.action === 'agent') {
          const [workers, state] = await Promise.all([deps.listWorkerNames(), deps.loadTopicState(chatId, threadId)]);
          // bp-retry (2026-08-25): mirror the canonical cascade (handleTunableCommand's
          // `state.preferred_worker || effectiveDefault`, main.ts) instead of terminating
          // on '' — a fresh/never-hydrated topic (no preferred_worker, no model_status)
          // used to render a single 'clear' button here while typed /model showed the
          // full declared list.
          // `||`, not `??`: the defect being fixed is an EMPTY-STRING worker, which `??`
          // preserves. Matches the canonical cascade (logic.ts:206, main.ts's tunable handler).
          const current = state.preferred_worker || state.model_status?.current_worker || (await deps.effectiveDefaultWorker(chatId, threadId));
          const keyboard = buildAgentPickerKeyboard(workers, current);
          await answerCallbackQuery(deps.token, cb.id);
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, keyboard);
            recordCardKeyboard(chatId, messageId, keyboard);
          }
          return 'cc:agent';
        }
        if (parsed.action === 'model' || parsed.action === 'effort') {
          const state = await deps.loadTopicState(chatId, threadId);
          // bp-retry (2026-08-25): same fallback fix as cc:agent above — never
          // terminate on '', which starves declared/observed lookups below and
          // collapses the picker to just 'clear'.
          const worker = state.preferred_worker || state.model_status?.current_worker || (await deps.effectiveDefaultWorker(chatId, threadId));
          const known = parsed.action === 'model' ? KNOWN_CLI_DEFAULT_MODELS : KNOWN_CLI_DEFAULT_EFFORTS;
          // Authoritative list first (config.yaml tunables.<setting>.values — same source
          // the typed /model and /effort commands read via logic.ts's renderTunableReport),
          // falling back to the hardcoded CLI default only when nothing is declared.
          const declared = worker ? await deps.declaredValues(worker, parsed.action).catch(() => []) : [];
          const observed = worker ? await deps.observedValues(worker, parsed.action).catch(() => []) : [];
          const knownDefault = worker ? known[worker.toLowerCase()] : undefined;
          const values = declared.length > 0
            ? Array.from(new Set([
                ...declared,
                ...observed.filter((v) => !declared.some((d) => d.toLowerCase() === v.toLowerCase())),
                'clear',
              ]))
            : Array.from(new Set([...(knownDefault ? [knownDefault] : []), ...observed, 'clear']));
          const current = parsed.action === 'model' ? state.model_status?.current_llm : state.model_status?.current_effort;
          const keyboard = buildValuePickerKeyboard(parsed.action, values, current);
          await answerCallbackQuery(deps.token, cb.id);
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, keyboard);
            recordCardKeyboard(chatId, messageId, keyboard);
          }
          return `cc:${parsed.action}`;
        }
        // 'set' | 'new' | 'stop' | 'ka' — synthesize a typed command
        const text = syntheticTextFor(parsed);
        if (!text) {
          await answerCallbackQuery(deps.token, cb.id, 'Unhandled control');
          return 'cc:unhandled';
        }
        await answerCallbackQuery(deps.token, cb.id);
        if (messageId) {
          await ackSelection(
            deps,
            cb,
            parsed.action === 'set'
              ? `${parsed.setting[0].toUpperCase()}${parsed.setting.slice(1)} → ${parsed.value}`
              : parsed.action === 'new'
                ? 'New topic'
                : parsed.action === 'stop'
                  ? 'Stop worker'
                  : 'Keep awake'
          );
          // 'set' completes the submenu press; 'new'/'stop'/'ka' also leave no submenu
          // displayed (keyboard just got stripped above) — either way there is nothing
          // left to protect from the sweep's top-level rewrite.
          clearCardKeyboard(chatId, messageId);
        }
        deps.injectUpdate(
          buildSyntheticUpdate({ updateId: nextSyntheticUpdateId(), chatId, threadId, messageId: messageId ?? 0, from: cb.from, text, via: 'button' })
        );
        return parsed.action === 'set' ? `cc:set:${parsed.setting}` : `cc:${parsed.action}`;
      }

      case 'wf': {
        if (parsed.action === 'retry') {
          const state = await deps.loadTopicState(chatId, threadId);
          // bp-retry (2026-08-25): a failover notice is sent as a reply to the
          // message that failed (main.ts's sendMessageWithKeyboard call passes the
          // failed message_id as reply_to_message_id), so the press carries its own
          // anchor — resolve THAT turn, never just "the newest user turn in the
          // topic", which can have moved on to an unrelated later message by the
          // time the user taps Retry (the exact silent-wrong-resend bug this
          // replaces). Only a legacy card with no reply_to_message (sent before
          // this fix) falls back to the old newest-user-turn behaviour.
          const anchorMessageId = cb.message?.reply_to_message?.message_id;
          let retryTurn: (typeof state.turns)[number] | undefined;
          if (anchorMessageId !== undefined) {
            retryTurn = state.turns.find((t) => t.role === 'user' && t.message_id === anchorMessageId);
            if (!retryTurn) {
              // The anchored message aged out of the topic's turn window (or
              // otherwise doesn't resolve) — do NOT fall back to the newest user
              // turn here, that would silently resend the wrong message again.
              await answerCallbackQuery(deps.token, cb.id, 'Original message no longer available to retry', true);
              return 'wf:retry:anchor-not-found';
            }
          } else {
            retryTurn = [...state.turns].reverse().find((t) => t.role === 'user');
            if (retryTurn) {
              logger.info('callback', 'wf:retry falling back to newest user turn (card has no reply_to_message anchor)', { chatId, threadId });
            }
          }
          if (!retryTurn) {
            await answerCallbackQuery(deps.token, cb.id, 'Nothing to retry in this topic', true);
            return 'wf:retry:nothing';
          }
          await answerCallbackQuery(deps.token, cb.id, '🔁 Retrying…');
          if (messageId) await ackSelection(deps, cb, 'Retry last message');
          deps.injectUpdate(
            buildSyntheticUpdate({
              updateId: nextSyntheticUpdateId(),
              chatId,
              threadId,
              messageId: messageId ?? 0,
              from: cb.from,
              text: retryTurn.text,
              via: 'button',
            })
          );
          return 'wf:retry';
        }
        const text = syntheticTextFor(parsed)!;
        await answerCallbackQuery(
          deps.token,
          cb.id,
          parsed.action === 'switch' ? `↔ Switching to ${parsed.worker}…` : `↩ Reverting to ${parsed.worker}…`
        );
        if (messageId) await ackSelection(deps, cb, parsed.action === 'switch' ? `Switch to ${parsed.worker}` : `Revert to ${parsed.worker}`);
        deps.injectUpdate(
          buildSyntheticUpdate({ updateId: nextSyntheticUpdateId(), chatId, threadId, messageId: messageId ?? 0, from: cb.from, text, via: 'button' })
        );
        return `wf:${parsed.action}`;
      }

      case 'pm': {
        // Verbatim behavioural move of main.ts:2419-2501 (audit lookup, 24h expiry,
        // approve/reject/diff, pa-alerts rejection notice) — only its home changes
        // (spec correction 16, WP-B0 edit 5). editMessageReplyMarkup calls on the
        // terminal approve/reject branches are new (P6 design rule (e) — every
        // terminal action removes its keyboard); 'diff' is not terminal, so it keeps
        // the keyboard, matching the original behaviour.
        const { readAuditRecords, appendAuditRecord } = await import('../../../pa/dist/src/lib/improvement-audit.js');
        const records = await readAuditRecords();
        const targetRecord = records.find((r) => r.ts === parsed.auditId || r.commit_hash === parsed.auditId);

        if (!targetRecord) {
          await answerCallbackQuery(deps.token, cb.id, 'Audit record not found', true);
          logger.info('callback', 'rejected - record not found', { refId: 'none', auditId: parsed.auditId, action: parsed.action, chatId, threadId });
          if (messageId) await ackSelection(deps, cb, `${parsed.action} — record not found`);
          return 'pm:not-found';
        }

        const recordAge = Date.now() - new Date(targetRecord.ts).getTime();
        const EXPIRY_MS = 24 * 60 * 60 * 1000;
        if (recordAge > EXPIRY_MS) {
          await answerCallbackQuery(deps.token, cb.id, 'This approval button has expired (24h limit)', true);
          logger.info('callback', 'rejected - expired', { refId: 'none', auditId: parsed.auditId, action: parsed.action, chatId, threadId, recordAge });
          if (messageId) await ackSelection(deps, cb, `${parsed.action} — expired`);
          return 'pm:expired';
        }

        const refId = makeRefId('cb');
        logger.info('callback', 'received', { refId, auditId: parsed.auditId, action: parsed.action, chatId, threadId });

        if (parsed.action === 'approve') {
          const reviewRecord = {
            ts: new Date().toISOString(),
            draft: targetRecord.draft,
            source_type: 'conversation' as const,
            action: 'rollback-accepted' as const,
            risk_flags: targetRecord.risk_flags,
            reason: 'Approved via HITL button by operator',
            accepted_at: new Date().toISOString(),
            accepted_by: 'operator',
            commit_hash: targetRecord.commit_hash,
          };
          await appendAuditRecord(reviewRecord);
          await answerCallbackQuery(deps.token, cb.id, '✅ Change approved');
          if (messageId) await ackSelection(deps, cb, 'Approve');
          await sendMessage(
            deps.token,
            chatId,
            appendRefIdAndLog(`✅ Approved change ${parsed.auditId} _Ref: ${refId}_`, { kind: 'callback', chatId, threadId }),
            messageId,
            threadId
          );
        } else if (parsed.action === 'reject') {
          const reviewRecord = {
            ts: new Date().toISOString(),
            draft: targetRecord.draft,
            source_type: 'conversation' as const,
            action: 'rollback-accepted' as const,
            risk_flags: targetRecord.risk_flags,
            reason: 'Rejected via HITL button by operator',
            accepted_at: new Date().toISOString(),
            accepted_by: 'operator',
            commit_hash: targetRecord.commit_hash,
          };
          await appendAuditRecord(reviewRecord);
          await answerCallbackQuery(deps.token, cb.id, '❌ Change rejected');
          if (messageId) await ackSelection(deps, cb, 'Reject');
          await sendMessage(
            deps.token,
            chatId,
            appendRefIdAndLog(`❌ Rejected change ${parsed.auditId} _Ref: ${refId}_`, { kind: 'callback', chatId, threadId }),
            messageId,
            threadId
          );
          const paAlertsChatId = deps.secrets['PA_ALERTS_CHAT_ID'] ? parseInt(deps.secrets['PA_ALERTS_CHAT_ID'], 10) : null;
          if (paAlertsChatId && !isNaN(paAlertsChatId)) {
            await sendMessage(deps.token, paAlertsChatId, `⚠️ Change ${parsed.auditId} was rejected by operator via HITL button.`);
          }
        } else {
          const diff = targetRecord.diff || 'No diff available';
          const chunks = diff.match(/[\s\S]{1,3000}/g) || ['No diff available'];
          const firstChunk = chunks[0];
          await answerCallbackQuery(deps.token, cb.id, '📄 Showing diff');
          await sendMessage(
            deps.token,
            chatId,
            appendRefIdAndLog(
              `📄 Diff for ${parsed.auditId}:\n\n${firstChunk}${chunks.length > 1 ? '\n\n...(truncated)' : ''} _Ref: ${refId}_`,
              { kind: 'callback', chatId, threadId }
            ),
            messageId,
            threadId
          );
        }
        return `pm:${parsed.action}`;
      }

      case 'dr': {
        if (parsed.action === 'show') {
          try {
            const { skill, meta } = await loadDraft(parsed.draft);
            const body = `📄 Draft *${parsed.draft}*\nReason: ${meta.reason}\n\n\`\`\`\n${skill.prompt.slice(0, 3000)}\n\`\`\``;
            await answerCallbackQuery(deps.token, cb.id, '📄 Showing draft');
            await sendMessage(deps.token, chatId, appendRefIdAndLog(body, { kind: 'callback', chatId, threadId }), messageId, threadId);
          } catch {
            await answerCallbackQuery(deps.token, cb.id, 'Draft not found', true);
            if (messageId) await ackSelection(deps, cb, 'Show draft — not found');
          }
          return 'dr:show';
        }
        spawnImpl('pa', [parsed.action, parsed.draft], { cwd: deps.botCwd, ...SPAWN_OPTS }).unref();
        await answerCallbackQuery(deps.token, cb.id, parsed.action === 'approve' ? '✅ Approving…' : '❌ Rejecting…');
        if (messageId) await ackSelection(deps, cb, parsed.action === 'approve' ? 'Approve' : 'Reject');
        return `dr:${parsed.action}`;
      }

      case 'sk': {
        const isProtected = parsed.kind === 'run' && PA_META_PROTECTED_SKILLS.has(parsed.name);
        let valid = false;
        if (!isProtected) {
          if (parsed.kind === 'run') {
            const skills = await listSkills().catch(() => []);
            valid = skills.some((s) => s.name === parsed.name);
          } else {
            valid = !!findJob(parsed.name);
          }
        }
        if (isProtected) {
          await answerCallbackQuery(deps.token, cb.id, `'${parsed.name}' can only be run by typing the command — buttons are refused for protected skills`, true);
          if (messageId) await ackSelection(deps, cb, `Run ${parsed.name} — refused (protected)`);
          return 'sk:protected';
        }
        if (!valid) {
          await answerCallbackQuery(deps.token, cb.id, 'Unknown skill or job — it may have been renamed', true);
          if (messageId) await ackSelection(deps, cb, `${parsed.kind === 'run' ? 'Run' : 'Job'} ${parsed.name} — unknown`);
          return 'sk:unknown';
        }
        if (!parsed.confirmed) {
          await answerCallbackQuery(deps.token, cb.id, 'Tap again to confirm');
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, buildRunNowKeyboard(parsed.kind, parsed.name, true));
          }
          return `sk:${parsed.kind}:unconfirmed`;
        }
        const args = parsed.kind === 'run' ? ['run', parsed.name] : ['maintenance', 'run', parsed.name];
        spawnImpl('pa', args, { cwd: deps.botCwd, ...SPAWN_OPTS }).unref();
        await answerCallbackQuery(deps.token, cb.id, `🚀 Started ${parsed.name}`);
        if (messageId) await ackSelection(deps, cb, `${parsed.kind === 'run' ? 'Run' : 'Job'} ${parsed.name} started`);
        return `sk:${parsed.kind}:started`;
      }

      case 'rm': {
        const message = extractReminderMessage(cb.message?.text ?? '');
        if (parsed.action === 'done') {
          recordDecision({ source: 'bot', skill: 'reminders', thread_id: threadId, chat_id: chatId, message_id: messageId, request_excerpt: message, decision: 'dismissed (done)', rationale: 'User acknowledged the reminder as handled.', alternatives: ['snoozed 1 h', 'snoozed to tomorrow 09:00 IST'] });
          await answerCallbackQuery(deps.token, cb.id, '✅ Done');
          if (messageId) await ackSelection(deps, cb, 'Done');
          return 'rm:done';
        }
        const dueAt = parsed.action === '1h' ? new Date(Date.now() + 60 * 60 * 1000).toISOString() : tomorrowNineAmIST();
        const scriptPath = join(deps.botCwd, 'projects', 'reminders', 'add_reminder.py');
        // shell:false — the message text contains spaces; shell:true would re-split it
        // across argv (spec item 454).
        const args = [scriptPath, dueAt, message, String(chatId)];
        if (threadId) args.push(String(threadId));
        spawnImpl(resolvePythonCommand(deps.runtimeEnv), args, { cwd: deps.botCwd, detached: true, stdio: 'ignore', shell: false, windowsHide: true }).unref();
        recordDecision({ source: 'bot', skill: 'reminders', thread_id: threadId, chat_id: chatId, message_id: messageId, request_excerpt: message, decision: parsed.action === '1h' ? 'snoozed 1 h' : 'snoozed to tomorrow 09:00 IST', rationale: 'User deferred the reminder from the reminder keyboard.', alternatives: parsed.action === '1h' ? ['dismissed (done)', 'snoozed to tomorrow 09:00 IST'] : ['dismissed (done)', 'snoozed 1 h'] });
        await answerCallbackQuery(deps.token, cb.id, parsed.action === '1h' ? '💤 Snoozed 1 h' : '🌅 Snoozed to tomorrow');
        if (messageId) await ackSelection(deps, cb, parsed.action === '1h' ? 'Snoozed 1 h' : 'Snoozed to tomorrow 09:00 IST');
        return `rm:${parsed.action}`;
      }

      case 'mc': {
        const actionWord = parsed.action === 'a' ? 'accept' : parsed.action === 'r' ? 'reject' : 'ignore';
        const scriptPath = join(deps.botCwd, 'pa', 'scripts', 'review_digest_action.py');
        spawnImpl(resolvePythonCommand(deps.runtimeEnv), [scriptPath, '--conflict-id', parsed.conflictId, '--action', actionWord], {
          cwd: deps.botCwd,
          ...SPAWN_OPTS,
        }).unref();
        const toast = actionWord === 'accept' ? '✅ Accepted' : actionWord === 'reject' ? '❌ Kept existing' : '🚫 Ignored';
        await answerCallbackQuery(deps.token, cb.id, toast);
        if (messageId) await ackSelection(deps, cb, actionWord === 'accept' ? 'Accept' : actionWord === 'reject' ? 'Keep existing' : 'Ignore');
        return `mc:${parsed.action}`;
      }

      case 'rs': {
        const key = resendKey(parsed.chatId, parsed.threadId, parsed.updateId);
        const record = await takeResend(key);
        if (!record) {
          await answerCallbackQuery(deps.token, cb.id, 'This resend link has expired or was already used', true);
          if (messageId) await ackSelection(deps, cb, 'Resend link expired');
          return 'rs:expired';
        }
        if (isBarePlaceholderUserText(record.userText) && record.userTextSettled !== true) {
          await answerCallbackQuery(deps.token, cb.id, 'That voice note was not transcribed — please send it again', true);
          if (messageId) await ackSelection(deps, cb, 'Not transcribed');
          return 'rs:untranscribed';
        }
        await answerCallbackQuery(deps.token, cb.id, '🔁 Resending…');
        if (messageId) await ackSelection(deps, cb, 'Resend');
        deps.injectUpdate(
          buildSyntheticUpdate({
            updateId: nextSyntheticUpdateId(),
            chatId: record.chatId,
            threadId: record.threadId,
            messageId: record.messageId,
            from: cb.from,
            text: record.userText,
            via: 'button',
          })
        );
        return 'rs:resent';
      }

      case 'dq': {
        // Re-validate the index against the live DLQ and compare refId — an index can
        // shift between the alert and the press (spec correction 19).
        const entries = await readDlqEntriesSlim();
        const entry = entries[parsed.index];
        const bodyRefMatch = /Ref:\s*(\S+)/.exec(cb.message?.text ?? '');
        const bodyRef = bodyRefMatch?.[1];
        const moved = !entry || (bodyRef !== undefined && entry.refId !== undefined && entry.refId !== bodyRef);
        if (moved) {
          await answerCallbackQuery(deps.token, cb.id, 'This DLQ entry has moved — check `pa dlq list`', true);
          if (messageId) await ackSelection(deps, cb, 'DLQ entry moved');
          return 'dq:stale';
        }
        if (!entry.quarantined) {
          await answerCallbackQuery(deps.token, cb.id, 'This entry is no longer quarantined', true);
          if (messageId) await ackSelection(deps, cb, 'No longer quarantined');
          return 'dq:not-quarantined';
        }
        if (!parsed.confirmed) {
          await answerCallbackQuery(deps.token, cb.id, 'Tap again to confirm replay');
          if (messageId) await editMessageReplyMarkup(deps.token, chatId, messageId, buildDlqReplayKeyboard(parsed.index, true));
          return 'dq:unconfirmed';
        }
        try {
          await dlqReplayCommand(String(parsed.index));
          await answerCallbackQuery(deps.token, cb.id, '▶ Replay queued');
        } catch (err) {
          await answerCallbackQuery(deps.token, cb.id, `Replay failed: ${(err as Error).message}`, true);
        }
        if (messageId) await ackSelection(deps, cb, 'Replay queued');
        return 'dq:replayed';
      }
    }
  } catch (err) {
    logger.warn('callback', `handler error: ${(err as Error).message}`, { chatId, threadId });
    await answerCallbackQuery(deps.token, cb.id, 'Error processing callback', true).catch(() => {});
    return 'error';
  }
}

// bp-fix (2026-08-24): MessageReactionUpdated (types.ts P2, frozen) carries no
// message_thread_id — only chat + message_id — so a reaction on a confirmation sent
// inside a non-General forum topic could not be resolved to its thread (see the
// WP-B0-era KNOWN LIMITATION this replaced). Fix: main.ts remembers every confirm
// message it sends here via rememberConfirmMessage; handleMessageReaction looks the
// thread back up by `${chatId}:${messageId}` and falls back to thread 0 only when the
// entry is unknown (e.g. bot restarted, entry aged out). In-memory only, bounded to the
// 200 most recent entries (oldest dropped first — a plain Map preserves insertion order).
const CONFIRM_THREAD_INDEX_MAX = 200;
const confirmThreadIndex = new Map<string, number>();

function confirmThreadKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Records which forum topic a confirmation message was sent into, so a later
 *  👍/👎 reaction on it (which carries no thread id of its own) can be resolved
 *  back to the right topic. Call this wherever `pending_action.message_id` is set. */
export function rememberConfirmMessage(chatId: number, messageId: number, threadId: number): void {
  const key = confirmThreadKey(chatId, messageId);
  confirmThreadIndex.delete(key); // re-inserting moves it to the end (most-recent)
  confirmThreadIndex.set(key, threadId);
  while (confirmThreadIndex.size > CONFIRM_THREAD_INDEX_MAX) {
    const oldestKey = confirmThreadIndex.keys().next().value;
    if (oldestKey === undefined) break;
    confirmThreadIndex.delete(oldestKey);
  }
}

/** Handles one message_reaction update. Only an ADD of 👍/👎 on the topic's
 *  pending_action.message_id does anything; everything else returns 'ignored'. */
export async function handleMessageReaction(mr: MessageReactionUpdated, deps: CallbackDeps): Promise<string> {
  try {
    const isAdd = mr.old_reaction.length === 0 && mr.new_reaction.length > 0;
    if (!isAdd) return 'ignored';

    const approvalEmoji = mr.new_reaction.find((r) => r.type === 'emoji' && (r.emoji === '👍' || r.emoji === '👎'));
    if (!approvalEmoji) return 'ignored';

    recordReaction(mr.chat.id, mr.message_id, approvalEmoji.emoji!);
    const indexKey = confirmThreadKey(mr.chat.id, mr.message_id);
    const threadId = confirmThreadIndex.get(indexKey) ?? 0;
    const state = await deps.loadTopicState(mr.chat.id, threadId);
    if (!state.pending_action || state.pending_action.message_id !== mr.message_id) {
      return 'ignored';
    }
    confirmThreadIndex.delete(indexKey);

    const text = approvalEmoji.emoji === '👍' ? 'yes' : 'no';
    deps.injectUpdate(
      buildSyntheticUpdate({
        updateId: nextSyntheticUpdateId(),
        chatId: mr.chat.id,
        threadId,
        messageId: mr.message_id,
        from: mr.user ?? { id: 0, first_name: 'unknown' },
        text,
        via: 'reaction',
      })
    );
    await setMessageReaction(deps.token, mr.chat.id, mr.message_id, '✅');
    return `reaction:${text}`;
  } catch (err) {
    logger.warn('reaction', `handler error: ${(err as Error).message}`, { chatId: mr.chat.id });
    return 'error';
  }
}
