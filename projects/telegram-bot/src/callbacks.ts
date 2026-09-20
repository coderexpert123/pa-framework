/**
 * Inline-button callback surface (2026-08-24 buttons program,
 * buttons-program design (internal) §3.1–§3.3, P6, WP-B0).
 *
 * WP-B0 fills the P6 skeleton. WP-B1 wires `handleCallbackQuery` / `handleMessageReaction`
 * into `runPollLoop` and supplies the `CallbackDeps` (including `injectUpdate`, the seam
 * that makes "a button is a typed command" literally true — a press that maps to a
 * command becomes a synthetic TelegramUpdate pushed into the next poll batch, never a
 * second code path).
 *
 * Callback grammar (≤64 bytes by construction; the parser returns null for anything
 * longer, malformed, or over-length in a field). SINGLE SOURCE since 2026-09-02 (topic-task
 * handover Wave 1, SPEC §3.4): the pure grammar lives in `pa/src/lib/callback-grammar.ts`
 * and is re-exported below so every existing import keeps working — pa-side emitters must
 * validate `callback_data` against the same module, never a mirror.
 *   reauth:google[:skill≤50]                       chat-gated
 *   cf:y | cf:n                                    chat-gated   (pending_action confirmation)
 *   cc:menu|agent|model|effort|back|new|stop|ka|submit|discard  chat-gated   (control card navigation/actions)
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
 *   qt:<tt-12hex>:<0-3>                            chat-gated   (executor-lane task question)
 *   rq:<threadN>:<0-3>                             chat-gated   (executor-lane thread question
 *                                                               option — AI-203 WP-3)
 *   sr:<idx>                                        chat-gated   (AI-234 quick-reply chip —
 *                                                               index resolves against the
 *                                                               topic's pending_suggestions)
 *   ru:<ruleId≤40>:a|x                             operator-gated (weekly-digest rules)
 *   si:<family≤40>:m[:c]                           operator-gated, two-step (census mute)
 *   ch:r:<chain≤40>[:c]                            operator-gated, two-step (chain re-run)
 *   wt:<watchId≤32>:r                              operator-gated (watch re-register)
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
  sendPlainMessage,
  setMessageReaction,
  editMessageText,
  sanitizeMdV2,
} from './telegram.js';
import type { ConversationState, TelegramUpdate, MessageReactionUpdated, CallbackQuery } from './types.js';
import { PA_META_PROTECTED_SKILLS } from './logic.js';
import { appendRefIdAndLog, makeRefId } from './ref-id.js';
import { resendKey, takeResend } from './resend-store.js';
import { isBarePlaceholderUserText } from './voice.js';
import { logger } from '../../../pa/dist/src/lib/log.js';
import { resolvePythonCommand } from '../../../pa/dist/src/lib/python.js';
import { paHome } from '../../../pa/dist/src/paths.js';
import { voiceInboxInputRequestAuthUrl } from '../../../pa/dist/src/lib/voice-inbox-ledger.js';
import { toIST, IST_OFFSET_MS } from '../../../pa/dist/src/ist.js';
import { listSkills } from '../../../pa/dist/src/skills.js';
import { loadDraft } from '../../../pa/dist/src/drafts.js';
import { findJob } from '../../../pa/dist/src/lib/maintenance/registry.js';
import { recordDecision, recordReaction } from '../../../pa/dist/src/lib/decisions.js';
import { dlqReplayCommand } from '../../../pa/dist/src/commands/dlq.js';
import { KNOWN_CLI_DEFAULT_MODELS, KNOWN_CLI_DEFAULT_EFFORTS } from '../../../pa/dist/src/lib/tunables.js';
import { appendTopicEvent } from '../../../pa/dist/src/lib/topic-events.js';
import { answerTask, type RunningTask } from '../../../pa/dist/src/lib/topic-tasks.js';
// AI-203 WP-3 (item 2): the `rq:` thread-question press resolves the answer
// against the topic's thread store. These three are safe per-key-lock store
// ops (file reads/writes under the topic key) — imported directly like
// answerTask above; the wake's fireClaimedThreads is injected via CallbackDeps
// (it fires real execution, so tests stub it).
import {
  takePendingQuestion,
  queueThreadInput,
  claimThreadStarts,
  getThread,
  updateThread,
  type ThreadRecord,
} from './topic-threads.js';
// The pure callback grammar is single-sourced in pa (SPEC §3.4) — imported here and
// re-exported below so every existing `from './callbacks.js'` import keeps working.
import {
  parseCallbackData,
  gateFor,
  CC_SET_CAPS,
  SK_NAME_RE,
} from '../../../pa/dist/src/lib/callback-grammar.js';

export { parseCallbackData, gateFor } from '../../../pa/dist/src/lib/callback-grammar.js';
export type { CallbackPrefix, CallbackGate, ParsedCallback } from '../../../pa/dist/src/lib/callback-grammar.js';
// Local type alias (not a re-declaration) so the handlers below keep the name.
import type { ParsedCallback } from '../../../pa/dist/src/lib/callback-grammar.js';

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
      ],
    ],
  };
}

// AI-210 (2026-09-06): the pickers stage-then-apply — [✅ Submit][↩ Discard] replaced
// ◀ Back as their last row. BACK_ROW stays defined: legacy cards on screen still emit
// cc:back, and sk:/dq:/si: confirm keyboards still use cc:back as their Cancel.
const BACK_ROW: InlineKeyboardButton[] = [{ text: '◀ Back', callback_data: 'cc:back' }];
const SUBMIT_DISCARD_ROW: InlineKeyboardButton[] = [
  { text: '✅ Submit', callback_data: 'cc:submit' },
  { text: '↩ Discard', callback_data: 'cc:discard' },
];

export function buildAgentPickerKeyboard(workers: string[], current: string | undefined, staged?: string): InlineKeyboardMarkup {
  const rows: InlineKeyboardButton[][] = [];
  for (const worker of workers) {
    const data = `cc:set:agent:${worker}`;
    if (data.length > 64 || worker.length > CC_SET_CAPS.agent) continue;
    // AI-210: staged wins over applied when both would mark the same button — staged is
    // staged even when it equals the applied value.
    const label = worker === staged ? `▸ ${worker}` : worker === current ? `• ${worker}` : worker;
    rows.push([{ text: label, callback_data: data }]);
  }
  rows.push(SUBMIT_DISCARD_ROW);
  return { inline_keyboard: rows };
}

export function buildValuePickerKeyboard(
  setting: 'model' | 'effort',
  values: string[],
  current?: string,
  staged?: string
): InlineKeyboardMarkup {
  const cap = CC_SET_CAPS[setting];
  const buttons: InlineKeyboardButton[] = [];
  for (const value of values) {
    const data = `cc:set:${setting}:${value}`;
    if (value.length === 0 || value.length > cap || data.length > 64) continue;
    const label = value === staged ? `▸ ${value}` : value === current ? `• ${value}` : value;
    buttons.push({ text: label, callback_data: data });
  }
  // A declared value list (e.g. agy's 11 models) makes a 1-per-row keyboard too tall for
  // a phone screen — lay out 2 per row once there are more than 6 surviving buttons.
  const perRow = buttons.length > 6 ? 2 : 1;
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  rows.push(SUBMIT_DISCARD_ROW);
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

/** PA_META `question` option buttons (2026-09-02, SPEC §3.3) — one button per row
 *  (options are prose-length), label = the option text verbatim (no emoji prefixes),
 *  callback_data `q:<idx>` ≤64 bytes by construction. Consumed by main.ts's kb
 *  cascade (WP-F); the `q:` press resolves the index against the topic's
 *  pending_question below. */
export function buildQuestionKeyboard(options: string[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map((optionText, idx) => [{ text: optionText, callback_data: `q:${idx}` }]),
  };
}

/** Wave-2 task-lane twin of buildQuestionKeyboard (SPEC §3.1 A.3): a parked
 *  task question renders `qt:<taskId>:<idx>` buttons — the answer routes to the
 *  TASK's micro-thread (answerTask), never a topic synthetic turn. ≤64 bytes
 *  by construction (taskId is tt- + 12 hex). Consumed by task-executor.ts's
 *  question FYI send; presses resolve via deps.loadRunningTasks below. */
export function buildTaskQuestionKeyboard(taskId: string, options: string[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map((optionText, idx) => [{ text: optionText, callback_data: `qt:${taskId}:${idx}` }]),
  };
}

/** AI-203 WP-3 (item 2, SPEC §5.1.7): the inline keyboard for an executor-lane
 *  THREAD question — one button per option, `callback_data: rq:<threadN>:<idx>`.
 *  The `<threadN>` is the ThreadRecord's numeric `n` (the executor's inline
 *  twin builder stamps the same shape); the `rq:` prefix is the pa-side
 *  callback grammar. ≤64 bytes by construction (same pattern as
 *  `buildTaskQuestionKeyboard`). Exported here for any future non-executor
 *  emitter; the executor builds its own inline twin per SPEC §6. */
export function buildThreadQuestionKeyboard(threadN: number, options: string[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: options.map((optionText, idx) => [{ text: optionText, callback_data: `rq:${threadN}:${idx}` }]),
  };
}

/** AI-234 (SPEC §3a): the inline keyboard for quick-reply chips — one button
 *  per row (chips are prose-length, like question options), label = the chip
 *  text verbatim, callback_data `sr:<idx>` (≤64 bytes by construction — the
 *  index is tiny; the label rides the button text, NOT callback_data). The
 *  press resolves the index against the topic's ephemeral
 *  pending_suggestions.items[idx] (set by main.ts when suggested_items survive
 *  sanitize). */
export function buildSuggestKeyboard(items: string[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: items.map((label, idx) => [{ text: label, callback_data: `sr:${idx}` }]),
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

/** WP-D2 B.5 (2026-09-02): census-family mute — two-tap like sk:/dq:. The pa-side
 *  nightly report emits the unconfirmed `si:<family>:m` button; this builder supplies
 *  the confirmed rewrite on the first tap. undefined for any family the grammar would
 *  refuse (defensive — pa-side emitters already charset/length-filter). */
export function buildFamilyMuteKeyboard(family: string, confirmed: boolean): InlineKeyboardMarkup | undefined {
  if (!parseCallbackData(`si:${family}:m`)) return undefined;
  if (!confirmed) {
    return { inline_keyboard: [[{ text: '🔇 Mute alerts', callback_data: `si:${family}:m` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: `⚠️ Confirm mute ${family}`, callback_data: `si:${family}:m:c` },
        { text: 'Cancel', callback_data: 'cc:back' },
      ],
    ],
  };
}

/** WP-D2 B.6 (2026-09-02): chain-failure re-run — two-tap like sk:/dq:. Names follow
 *  the SK_NAME_RE charset (same grammar as the chains store). */
export function buildChainRetryKeyboard(chain: string, confirmed: boolean): InlineKeyboardMarkup | undefined {
  if (!SK_NAME_RE.test(chain)) return undefined;
  if (!confirmed) {
    return { inline_keyboard: [[{ text: '🔁 Re-run chain', callback_data: `ch:r:${chain}` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: `⚠️ Confirm re-run ${chain}`, callback_data: `ch:r:${chain}:c` },
        { text: 'Cancel', callback_data: 'cc:back' },
      ],
    ],
  };
}

/** Pure. The text a press is equivalent to typing, or null when the press is not a
 *  synthetic-message action (menu navigation, approvals handled in-process), or when it
 *  synthesizes but needs an async lookup this pure function cannot do (`wf:retry`,
 *  `rs:`) — and `cc:submit`, which derives its injection from the recorded staged
 *  selection (in-memory card keyboard index), are built directly by
 *  handleCallbackQuery instead. */
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
      return null; // menu, agent, model, effort, back, submit, discard — handled in-process
    case 'wf':
      if (parsed.action === 'switch' || parsed.action === 'revert') return `/agent ${parsed.worker}`;
      return null; // 'retry' needs the topic's last user turn — async, see handleCallbackQuery
    default:
      return null; // reauth, q, sr, pm, dr, sk, rm, mc, rs, dq — handled in-process
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
// AI-210 (2026-09-06): a staged selection is stronger intent than an opened submenu —
// it stays fresh for 10 minutes so the periodic sweep's in-place refresh cannot wipe a
// selection the operator is still looking at. Past the window the entry reads as
// absent: the sweep re-attaches the top-level keyboard and the selection is silently
// dropped — nothing was applied; a later cc:submit finds no entry → "No change".
const CARD_SELECTION_FRESH_MS = 10 * 60 * 1000;
interface CardKeyboardEntry {
  keyboard: InlineKeyboardMarkup;
  /** The staged-but-not-yet-applied selection, if one is staged on this picker. */
  selection?: { setting: 'agent' | 'model' | 'effort'; value: string };
  recordedAt: number;
}
const cardKeyboardIndex = new Map<string, CardKeyboardEntry>();

function cardKeyboardKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Records the submenu keyboard now displayed on a control-card message. Call this
 *  wherever a cc: picker is rendered in place — the open branches pass NO selection
 *  (a fresh open is unstaged); the cc:set staging press passes the selection. */
function recordCardKeyboard(
  chatId: number,
  messageId: number,
  keyboard: InlineKeyboardMarkup,
  now: number = Date.now(),
  selection?: { setting: 'agent' | 'model' | 'effort'; value: string }
): void {
  const key = cardKeyboardKey(chatId, messageId);
  cardKeyboardIndex.delete(key); // re-inserting moves it to the end (most-recent)
  cardKeyboardIndex.set(key, { keyboard, selection, recordedAt: now });
  while (cardKeyboardIndex.size > CARD_KEYBOARD_INDEX_MAX) {
    const oldestKey = cardKeyboardIndex.keys().next().value;
    if (oldestKey === undefined) break;
    cardKeyboardIndex.delete(oldestKey);
  }
}

/** Clears any recorded submenu for a control-card message — call on cc:menu/cc:back/
 *  cc:submit/cc:discard (returns to the top-level menu), and from main.ts's
 *  replacePinnedStatusCard for the SUPERSEDED card id (its entry can never be
 *  reached again — Telegram never reuses a message id — so it would sit dead in the map). */
export function clearCardKeyboard(chatId: number, messageId: number): void {
  cardKeyboardIndex.delete(cardKeyboardKey(chatId, messageId));
}

/** Test hook: empty the whole submenu index between tests. Picker-opening tests
 *  record under shared fixture keys (chat 555, message 100); without this, a
 *  recording from one test leaks into a later test's ackSelection edit. Never
 *  called in production. */
export function _resetCardKeyboardIndexForTest(): void {
  cardKeyboardIndex.clear();
}

/** AI-210: the fresh-checked entry (keyboard + staged selection) for a control-card
 *  message — the single freshness decision behind currentCardKeyboard and the
 *  cc:submit/cc:discard handler. Undefined when absent or stale. `now` injectable. */
function freshCardEntry(chatId: number, messageId: number, now: number = Date.now()): CardKeyboardEntry | undefined {
  const entry = cardKeyboardIndex.get(cardKeyboardKey(chatId, messageId));
  if (!entry) return undefined;
  if (now - entry.recordedAt > (entry.selection ? CARD_SELECTION_FRESH_MS : CARD_KEYBOARD_FRESH_MS)) return undefined;
  return entry;
}

/** Returns the submenu keyboard currently displayed on this control-card message, if
 *  one was recorded within its freshness window (2 min bare, 10 min with a staged
 *  selection) — else undefined (meaning: show the top-level buildControlCardKeyboard()).
 *  `now` is injectable for tests. */
export function currentCardKeyboard(chatId: number, messageId: number, now: number = Date.now()): InlineKeyboardMarkup | undefined {
  return freshCardEntry(chatId, messageId, now)?.keyboard;
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
  /** Wave-2 executor lane (SPEC §3.1 A.3): the topic's running-store records,
   *  read fresh per press — `qt:` resolves its taskId against these. Injected
   *  (pa/dist listRunningTasks) to keep this module's constructor-time imports
   *  identical to what tests stub. */
  loadRunningTasks: (chatId: number, threadId: number) => Promise<RunningTask[]>;
  /** AI-203 WP-3 (item 2): fires every claimed record of one topic after an
   *  `rq:` thread-question press parks a terminal thread as 'queued' and
   *  claimThreadStarts flips it to running. Injected (not imported) because it
   *  fires real execution; tests stub it. Optional so existing test fixtures
   *  (callbacks.test.ts's makeDeps) keep compiling without it — when omitted
   *  the `rq:` handler logs a warning and skips the fire (the record is still
   *  'running' from claimThreadStarts; the next poll-tick reconcile wakes it). */
  fireClaimedThreads?: (
    topicKey: string,
    claimed: ThreadRecord[],
    opts: { secrets: Record<string, string>; token: string; topicName: string }
  ) => void;
  /** AI-203 WP-3 (item 2): the topic name for the fireClaimedThreads opts.
   *  Optional — defaults to '' (the executor's prompt header tolerates an
   *  unresolvable name). main.ts wires the real getTopicName resolver. */
  topicNameFor?: (chatId: number, threadId: number) => string;
  /** Auth broker Phase A (2026-09-10 build spec §3.9): resolves a pending
   *  `auth:` request's authorize URL, or null when unresolvable. Optional —
   *  the default (`defaultAuthRequestUrl`, in-module) is used when omitted. */
  authRequestUrl?: (requestId: string) => Promise<string | null>;
}

/** AI-210: the ONE derivation behind the cc:agent/cc:model/cc:effort open branches AND
 *  the cc:set staging re-render — a staged re-render can then never show a different
 *  list than a fresh open of the same picker.
 *  bp-retry (2026-08-25) rationale, moved here with the code: mirror the canonical
 *  cascade (handleTunableCommand's `state.preferred_worker || effectiveDefault`,
 *  main.ts) instead of terminating on '' — a fresh/never-hydrated topic (no
 *  preferred_worker, no model_status) used to render a single 'clear' button here
 *  while typed /model showed the full declared list. `||`, not `??`: the defect being
 *  fixed is an EMPTY-STRING worker, which `??` preserves. */
async function pickerContextFor(
  deps: CallbackDeps,
  chatId: number,
  threadId: number,
  setting: 'agent' | 'model' | 'effort'
): Promise<{ values: string[]; current: string | undefined }> {
  if (setting === 'agent') {
    const [workers, state] = await Promise.all([deps.listWorkerNames(), deps.loadTopicState(chatId, threadId)]);
    const current = state.preferred_worker || state.model_status?.current_worker || (await deps.effectiveDefaultWorker(chatId, threadId));
    return { values: workers, current };
  }
  const state = await deps.loadTopicState(chatId, threadId);
  const worker = state.preferred_worker || state.model_status?.current_worker || (await deps.effectiveDefaultWorker(chatId, threadId));
  // Authoritative list first (config.yaml tunables.<setting>.values — same source the
  // typed /model and /effort commands read via logic.ts's renderTunableReport), falling
  // back to the hardcoded CLI default only when nothing is declared.
  const known = setting === 'model' ? KNOWN_CLI_DEFAULT_MODELS : KNOWN_CLI_DEFAULT_EFFORTS;
  const declared = worker ? await deps.declaredValues(worker, setting).catch(() => []) : [];
  const observed = worker ? await deps.observedValues(worker, setting).catch(() => []) : [];
  const knownDefault = worker ? known[worker.toLowerCase()] : undefined;
  const values = declared.length > 0
    ? Array.from(new Set([
        ...declared,
        ...observed.filter((v) => !declared.some((d) => d.toLowerCase() === v.toLowerCase())),
        'clear',
      ]))
    : Array.from(new Set([...(knownDefault ? [knownDefault] : []), ...observed, 'clear']));
  return { values, current: setting === 'model' ? state.model_status?.current_llm : state.model_status?.current_effort };
}

const SPAWN_OPTS = { detached: true, stdio: 'ignore' as const, shell: true, windowsHide: true };

/** WB-304: fire-and-forget spawns must never fail invisibly — every child gets
 *  an error listener that logs the failure before unref, so a missing `pa` (or
 *  any spawn failure) reaches the log instead of dying silently. */
function spawnPaLogged(cmd: string, args: string[], cwd: string, context: Record<string, unknown>): void {
  spawnImpl(cmd, args, { cwd, ...SPAWN_OPTS })
    .on('error', (err) => {
      logger.warn('callback', `fire-and-forget spawn failed: ${(err as Error).message}`, context);
    })
    .unref();
}

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

    // AI-192 (2026-09-03): editMessageText strips keyboards unless reply_markup
    // is re-passed. When this edit lands on the pinned control card mid-submenu
    // (a fresh recorded keyboard), re-attach it; in-thread button messages have
    // no recorded submenu → undefined → the keyboard strips after the press
    // exactly as always.
    const success = await editMessageText(deps.token, chatId, messageId, full, currentCardKeyboard(chatId, messageId), { rawMarkdown: true });
    if (!success) {
      // Fallback: edit failed (message older than 48h, entity mismatch, network, etc.)
      await editMessageReplyMarkup(deps.token, chatId, messageId, undefined);
      await sendMessage(deps.token, chatId, `✅ Selected: ${label}`, messageId, threadId || undefined);
    }
  } catch (err) {
    logger.warn('callback', `ackSelection error: ${(err as Error).message}`, { label });
  }
}

/**
 * Default reader for the `auth:` callback's `CallbackDeps.authRequestUrl` seam
 * (auth broker Phase A, 2026-09-10 build spec §3.9). `auth_url` is minted
 * into the voice-inbox LEDGER's `input_requests.params_json`, never into the
 * §3.3 broker row (`~/.pa/auth/requests/<id>.json`) — neither real writer's
 * `AuthRequestRow` shape (`pa/src/lib/auth/store.ts`,
 * `projects/voice-inbox/src/auth-providers.ts`) carries that field, so
 * reading the broker-row file here always resolved null in production
 * (fixed, deep-recheck 2026-09-10 — see `pa/src/lib/voice-inbox-ledger.ts`'s
 * `voiceInboxInputRequestAuthUrl` for the full explanation). Read-only,
 * fail-open: any failure (bad id, missing ledger, torn params) returns null,
 * same as before.
 */
async function defaultAuthRequestUrl(requestId: string): Promise<string | null> {
  return voiceInboxInputRequestAuthUrl(requestId);
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

      case 'auth': {
        const url = await (deps.authRequestUrl ?? defaultAuthRequestUrl)(parsed.requestId);
        await answerCallbackQuery(deps.token, cb.id, '🔐 Opening the authorization link…');
        if (messageId) await ackSelection(deps, cb, 'Open authorization link');
        if (url) {
          // sendPlainMessage, NOT sendMessage — a raw URL through sendMessage's
          // MarkdownV2 escaping comes back backslash-mangled and non-tappable
          // (2026-08-15 OAuth-URL lesson, pa/CLAUDE.md; proven in telegram.test.ts).
          await sendPlainMessage(deps.token, chatId, url, threadId || undefined);
          return 'auth:opened';
        }
        return 'auth:unresolved';
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

      case 'q': {
        // PA_META question answer (2026-09-02, SPEC §3.3) — the press IS typing the
        // option text: injected as a synthetic turn through the one-parser path, so
        // button and typed behaviour cannot diverge. Not reusing cf:y/n — that prefix
        // is semantically bound to pending_action and cannot carry 1-4 options.
        const state = await deps.loadTopicState(chatId, threadId);
        if (!state.pending_question) {
          await answerCallbackQuery(deps.token, cb.id, 'Question no longer active', true);
          return 'q:gone';
        }
        const optionText = state.pending_question.options[parsed.index];
        if (optionText === undefined) {
          await answerCallbackQuery(deps.token, cb.id, 'Invalid option', true);
          return 'q:bad';
        }
        await answerCallbackQuery(deps.token, cb.id, `✅ ${optionText}`);
        if (messageId) await ackSelection(deps, cb, optionText);
        deps.injectUpdate(
          buildSyntheticUpdate({
            updateId: nextSyntheticUpdateId(),
            chatId,
            threadId,
            messageId: messageId ?? 0,
            from: cb.from,
            text: optionText,
            via: 'button',
          })
        );
        try {
          await appendTopicEvent(chatId, threadId, {
            kind: 'question_answered',
            ref: state.pending_question.task_id ?? null,
            detail: optionText,
          });
        } catch (err) {
          // The injected turn is the load-bearing effect; a failed audit line must not
          // turn a completed press into an 'error' outcome (ackSelection precedent).
          logger.warn('callback', `question_answered event failed: ${(err as Error).message}`, { chatId, threadId });
        }
        return 'q:answered';
      }

      case 'qt': {
        // Wave-2 task-lane question press (SPEC §3.1 A.3). Convergence, not
        // injection: the press answers the TASK (answerTask) directly — it must
        // NOT inject a poll-loop turn, because a task answer lives in the task's
        // micro-thread and the next drain tick resumes the parked record.
        const running = await deps.loadRunningTasks(chatId, threadId);
        const task = running.find((r) => r.id === parsed.taskId);
        if (!task || task.question === null) {
          await answerCallbackQuery(deps.token, cb.id, 'Task question no longer active', true);
          return 'qt:gone';
        }
        const optionText = task.question.options[parsed.index];
        if (optionText === undefined) {
          await answerCallbackQuery(deps.token, cb.id, 'Invalid option', true);
          return 'qt:bad';
        }
        await answerTask(chatId, threadId, task.id, optionText);
        if (messageId) await ackSelection(deps, cb, optionText);
        await answerCallbackQuery(deps.token, cb.id, '✅ Sent to task');
        try {
          await appendTopicEvent(chatId, threadId, {
            kind: 'question_answered',
            ref: task.id,
            detail: optionText,
          });
        } catch (err) {
          // answerTask already landed; a failed audit line must not turn the
          // press into an 'error' outcome (q: precedent above).
          logger.warn('callback', `question_answered event failed: ${(err as Error).message}`, { chatId, threadId });
        }
        return 'qt:answered';
      }

      case 'rq': {
        // AI-203 WP-3 (item 2, SPEC §5.1.7): executor-lane THREAD question
        // press. Convergence, not injection — the press answers the THREAD
        // directly (takePendingQuestion + queueThreadInput + wake), it must
        // NOT inject a poll-loop turn (the answer lives in the thread's
        // pendingInput and the executor's wake path delivers it). Mirrors
        // handleSteer's terminal wake: park a terminal record as 'queued' so
        // the FIFO claim owns the start, then claimThreadStarts +
        // fireClaimedThreads. The `rq:` press must NOT take the topic lock for
        // an orchestrator dispatch (it is a thread steer, not an orchestrator
        // turn) — direct store write + executor fire, assistantWorker 'local'.
        const topicKey = `${chatId}_${threadId}`;
        const threadRecId = `t-${parsed.threadN}`;
        const question = await takePendingQuestion(topicKey, threadRecId).catch(() => undefined);
        if (!question) {
          // Idempotent no-op for a stale button press (already answered, or
          // the record is gone/cancelled). Graceful, no store write.
          await answerCallbackQuery(deps.token, cb.id, 'Question already answered or expired', true);
          return 'rq:gone';
        }
        const optionText = question.options[parsed.index];
        if (optionText === undefined) {
          await answerCallbackQuery(deps.token, cb.id, 'Invalid option', true);
          return 'rq:bad';
        }
        const queued = await queueThreadInput(topicKey, threadRecId, optionText).catch(() => ({ ok: false as const, reason: 'queue write failed' }));
        if (!queued.ok) {
          await answerCallbackQuery(deps.token, cb.id, `Could not route: ${queued.reason}`, true);
          return 'rq:queue-failed';
        }
        // Wake path (handleSteer's terminal-wake precedent): park a terminal
        // record as 'queued' so claimThreadStarts owns the start; a running
        // record just drains the queued input on its current run.
        const parked = await getThread(topicKey, threadRecId).catch(() => undefined);
        if (parked && (parked.status === 'done' || parked.status === 'failed')) {
          await updateThread(topicKey, threadRecId, { status: 'queued' }).catch(() => {});
        }
        const claimed = await claimThreadStarts(topicKey).catch(() => []);
        if (claimed.length > 0 && deps.fireClaimedThreads) {
          const topicName = deps.topicNameFor ? deps.topicNameFor(chatId, threadId) : '';
          deps.fireClaimedThreads(topicKey, claimed, { secrets: deps.secrets, token: deps.token, topicName });
        } else if (claimed.length > 0) {
          // fireClaimedThreads not wired (a test fixture without it): the
          // record is 'running' from claimThreadStarts; the next poll-tick
          // reconcile wakes it. Log so a production misconfiguration surfaces.
          logger.warn('callback', 'rq: press claimed threads but no fireClaimedThreads dep wired', { chatId, threadId, threadRecId });
        }
        await answerCallbackQuery(deps.token, cb.id, `✅ ${optionText}`);
        if (messageId) await ackSelection(deps, cb, optionText);
        await sendMessage(
          deps.token,
          chatId,
          appendRefIdAndLog(`✅ Answered: ${optionText} — routed to thread ${threadRecId}.`, { kind: 'callback', chatId, threadId }),
          undefined,
          threadId || undefined
        );
        try {
          await appendTopicEvent(chatId, threadId, {
            kind: 'question_answered',
            ref: threadRecId,
            detail: optionText,
          });
        } catch (err) {
          // The queued input + wake are the load-bearing effect; a failed
          // audit line must not turn the press into an 'error' outcome.
          logger.warn('callback', `question_answered event failed: ${(err as Error).message}`, { chatId, threadId });
        }
        return 'rq:answered';
      }

      case 'sr': {
        // AI-234 (SPEC §3a): quick-reply chip press. The press IS typing the
        // chip text: injected as a synthetic turn through the one-parser path
        // (the same path q:/qt: use — a press is a typed command, CLAUDE.md:111).
        // The index resolves against the topic's ephemeral pending_suggestions;
        // the chip text lives in button text, NOT callback_data. Clear
        // pending_suggestions and strip the keyboard (AI-192 rule).
        const state = await deps.loadTopicState(chatId, threadId);
        if (!state.pending_suggestions) {
          await answerCallbackQuery(deps.token, cb.id, 'Those suggestions are no longer active', true);
          return 'sr:gone';
        }
        const chipText = state.pending_suggestions.items[parsed.index];
        if (chipText === undefined) {
          await answerCallbackQuery(deps.token, cb.id, 'Invalid suggestion', true);
          return 'sr:bad';
        }
        await answerCallbackQuery(deps.token, cb.id, `✅ ${chipText}`);
        if (messageId) await ackSelection(deps, cb, chipText);
        deps.injectUpdate(
          buildSyntheticUpdate({
            updateId: nextSyntheticUpdateId(),
            chatId,
            threadId,
            messageId: messageId ?? 0,
            from: cb.from,
            text: chipText,
            via: 'button',
          })
        );
        return 'sr:answered';
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
          const { values: workers, current } = await pickerContextFor(deps, chatId, threadId, 'agent');
          const keyboard = buildAgentPickerKeyboard(workers, current);
          await answerCallbackQuery(deps.token, cb.id);
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, keyboard);
            recordCardKeyboard(chatId, messageId, keyboard);
          }
          return 'cc:agent';
        }
        if (parsed.action === 'model' || parsed.action === 'effort') {
          const { values, current } = await pickerContextFor(deps, chatId, threadId, parsed.action);
          const keyboard = buildValuePickerKeyboard(parsed.action, values, current);
          await answerCallbackQuery(deps.token, cb.id);
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, keyboard);
            recordCardKeyboard(chatId, messageId, keyboard);
          }
          return `cc:${parsed.action}`;
        }
        if (parsed.action === 'submit') {
          // AI-210 (2026-09-06): apply the staged selection by injecting EXACTLY the
          // typed command the cc:set press used to inject — button and typing cannot
          // diverge. The staged selection lives in the in-memory card keyboard index
          // (an async lookup syntheticTextFor cannot do — the wf:retry precedent).
          const entry = messageId !== undefined ? freshCardEntry(chatId, messageId) : undefined;
          if (entry?.selection) {
            const { setting, value } = entry.selection;
            const text = syntheticTextFor({ prefix: 'cc', action: 'set', setting, value, raw: `cc:set:${setting}:${value}` });
            await answerCallbackQuery(deps.token, cb.id, `Applying ${setting} → ${value}…`);
            if (messageId) {
              // Back to the top-level card (what cc:back does today). The entry is
              // CLEARED, not re-recorded: after submit the displayed keyboard IS the
              // top-level menu, and the top-level menu is what the sweep re-attaches
              // by default — a recorded top-level keyboard would be redundant state.
              await editMessageReplyMarkup(deps.token, chatId, messageId, buildControlCardKeyboard());
              clearCardKeyboard(chatId, messageId);
            }
            deps.injectUpdate(
              buildSyntheticUpdate({ updateId: nextSyntheticUpdateId(), chatId, threadId, messageId: messageId ?? 0, from: cb.from, text: text!, via: 'button' })
            );
            return 'cc:submit';
          }
          // No / expired selection: exactly cc:back — nothing was applied.
          await answerCallbackQuery(deps.token, cb.id, 'No change');
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, buildControlCardKeyboard());
            clearCardKeyboard(chatId, messageId);
          }
          return 'cc:submit:no-change';
        }
        if (parsed.action === 'discard') {
          // AI-210: revert the staged selection — nothing was applied. Exactly cc:back.
          const entry = messageId !== undefined ? freshCardEntry(chatId, messageId) : undefined;
          await answerCallbackQuery(
            deps.token,
            cb.id,
            entry?.selection ? `Discarded — ${entry.selection.setting} unchanged` : 'Discarded'
          );
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, buildControlCardKeyboard());
            clearCardKeyboard(chatId, messageId);
          }
          return 'cc:discard';
        }
        if (parsed.action === 'set') {
          // AI-210 (2026-09-06): a value press STAGES — no injection, no state change.
          // Re-render the same picker with the tapped value staged (▸) and record the
          // selection; Submit injects the typed command. (Topic-state writes happen
          // under the topic lock inside processUpdate — staging keeps this press
          // side-effect-free until the operator confirms.)
          const ctx = await pickerContextFor(deps, chatId, threadId, parsed.setting);
          const keyboard = parsed.setting === 'agent'
            ? buildAgentPickerKeyboard(ctx.values, ctx.current, parsed.value)
            : buildValuePickerKeyboard(parsed.setting, ctx.values, ctx.current, parsed.value);
          await answerCallbackQuery(
            deps.token,
            cb.id,
            `${parsed.setting[0].toUpperCase()}${parsed.setting.slice(1)} → ${parsed.value} · Submit to apply`
          );
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, keyboard);
            recordCardKeyboard(chatId, messageId, keyboard, Date.now(), { setting: parsed.setting, value: parsed.value });
          }
          return `cc:set:${parsed.setting}`;
        }
        // 'new' | 'stop' — synthesize a typed command
        const text = syntheticTextFor(parsed);
        if (!text) {
          await answerCallbackQuery(deps.token, cb.id, 'Unhandled control');
          return 'cc:unhandled';
        }
        // AI-192 (2026-09-03): NO selected-value echo on cc: presses. ackSelection
        // used to append "✅ Selected: …" to the pinned card and strip its keyboard
        // in the same editMessageText; the echo was erased anyway when the injected
        // command's dispatch refreshed the card (renderStatusCard regenerates the
        // text), and between press and refresh the picker was simply gone. The toast
        // carries the feedback; the pin itself just reflects the new state when the
        // synthetic command's refresh lands (keyboard re-attached there).
        await answerCallbackQuery(
          deps.token,
          cb.id,
          parsed.action === 'new' ? 'New topic' : 'Stop worker'
        );
        if (messageId) {
          // 'new'/'stop' are top-level presses with no submenu displayed — nothing
          // left to protect from the sweep's top-level rewrite. (cc:set no longer
          // passes here — it stages in its own branch above.)
          clearCardKeyboard(chatId, messageId);
        }
        deps.injectUpdate(
          buildSyntheticUpdate({ updateId: nextSyntheticUpdateId(), chatId, threadId, messageId: messageId ?? 0, from: cb.from, text, via: 'button' })
        );
        return `cc:${parsed.action}`;
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
        spawnPaLogged('pa', [parsed.action, parsed.draft], deps.botCwd, { action: parsed.action, draft: parsed.draft });
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
        spawnPaLogged('pa', args, deps.botCwd, { kind: parsed.kind, name: parsed.name });
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
        // WB-304: error listener so a spawn failure (missing python) is never invisible.
        spawnImpl(resolvePythonCommand(deps.runtimeEnv), args, { cwd: deps.botCwd, detached: true, stdio: 'ignore', shell: false, windowsHide: true })
          .on('error', (err) => {
            logger.warn('callback', `reminder spawn failed: ${(err as Error).message}`, { chatId });
          })
          .unref();
        recordDecision({ source: 'bot', skill: 'reminders', thread_id: threadId, chat_id: chatId, message_id: messageId, request_excerpt: message, decision: parsed.action === '1h' ? 'snoozed 1 h' : 'snoozed to tomorrow 09:00 IST', rationale: 'User deferred the reminder from the reminder keyboard.', alternatives: parsed.action === '1h' ? ['dismissed (done)', 'snoozed to tomorrow 09:00 IST'] : ['dismissed (done)', 'snoozed 1 h'] });
        await answerCallbackQuery(deps.token, cb.id, parsed.action === '1h' ? '💤 Snoozed 1 h' : '🌅 Snoozed to tomorrow');
        if (messageId) await ackSelection(deps, cb, parsed.action === '1h' ? 'Snoozed 1 h' : 'Snoozed to tomorrow 09:00 IST');
        return `rm:${parsed.action}`;
      }

      case 'mc': {
        const actionWord = parsed.action === 'a' ? 'accept' : parsed.action === 'r' ? 'reject' : 'ignore';
        const scriptPath = join(deps.botCwd, 'pa', 'scripts', 'review_digest_action.py');
        // shell:false (WB-301): argv is already array-form, so shell:true only adds a
        // word-splitting surface; a spawn failure surfaces via the error listener below
        // instead of hiding behind the Accepted toast.
        spawnImpl(resolvePythonCommand(deps.runtimeEnv), [scriptPath, '--conflict-id', parsed.conflictId, '--action', actionWord], {
          cwd: deps.botCwd,
          detached: true,
          stdio: 'ignore' as const,
          shell: false,
          windowsHide: true,
        }).on('error', (err) => {
          logger.warn('callback', `review_digest spawn failed: ${(err as Error).message}`, { conflictId: parsed.conflictId, action: actionWord });
        }).unref();
        const toast = actionWord === 'accept' ? '✅ Accepted' : actionWord === 'reject' ? '❌ Kept existing' : '🚫 Ignored';
        await answerCallbackQuery(deps.token, cb.id, toast);
        if (messageId) await ackSelection(deps, cb, actionWord === 'accept' ? 'Accept' : actionWord === 'reject' ? 'Keep existing' : 'Ignore');
        return `mc:${parsed.action}`;
      }

      case 'ow': {
        const sub = parsed.action === 'l' ? 'land' : parsed.action === 'k' ? 'keep' : 'diff';
        spawnPaLogged('pa', ['orphan', sub, parsed.gid], deps.botCwd, { gid: parsed.gid, sub });
        const toast = parsed.action === 'l' ? '📥 Landing…' : parsed.action === 'k' ? '💤 Keeping dirty 24h' : '📄 Showing diff';
        await answerCallbackQuery(deps.token, cb.id, toast);
        if (messageId) await ackSelection(deps, cb, toast.replace(/^\S+\s/, ''));
        return `ow:${parsed.action}`;
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

      case 'ru': {
        // WP-D2 B.2 (2026-09-02): weekly-digest rules accept/reject — same spawn
        // pattern as dr: (fire-and-forget pa CLI, ack into the message).
        const args = parsed.action === 'a'
          ? ['rules', 'accept', parsed.ruleId]
          : ['rules', 'supersede', parsed.ruleId, '--reason', 'rejected via weekly-digest button'];
        spawnPaLogged('pa', args, deps.botCwd, { ruleId: parsed.ruleId });
        await answerCallbackQuery(deps.token, cb.id, parsed.action === 'a' ? '✅ Accepting…' : '✖ Rejecting…');
        if (messageId) {
          await ackSelection(deps, cb, parsed.action === 'a' ? `Accept rule ${parsed.ruleId}` : `Reject rule ${parsed.ruleId}`);
        }
        return parsed.action === 'a' ? 'ru:accepted' : 'ru:rejected';
      }

      case 'si': {
        // WP-D2 B.5 (2026-09-02): mute a census family via a fix record — two-tap.
        if (!parsed.confirmed) {
          await answerCallbackQuery(deps.token, cb.id, 'Tap again to confirm mute');
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, buildFamilyMuteKeyboard(parsed.family, true));
          }
          return 'si:unconfirmed';
        }
        spawnPaLogged('pa', ['fix', parsed.family, '--note', 'muted from nightly report button'], deps.botCwd, { family: parsed.family });
        await answerCallbackQuery(deps.token, cb.id, '🔇 Muting…');
        if (messageId) await ackSelection(deps, cb, `Mute ${parsed.family}`);
        return 'si:muted';
      }

      case 'ch': {
        // WP-D2 B.6 (2026-09-02): re-run a failed chain — two-tap, then re-validate
        // the chain still exists (the report may predate its removal, dq: precedent).
        if (!parsed.confirmed) {
          await answerCallbackQuery(deps.token, cb.id, 'Tap again to confirm re-run');
          if (messageId) {
            await editMessageReplyMarkup(deps.token, chatId, messageId, buildChainRetryKeyboard(parsed.chain, true));
          }
          return 'ch:unconfirmed';
        }
        let exists = false;
        try {
          await readFile(join(paHome(), 'chains', `${parsed.chain}.yaml`), 'utf8');
          exists = true;
        } catch {
          exists = false;
        }
        if (!exists) {
          await answerCallbackQuery(deps.token, cb.id, 'Unknown chain — it may have been removed', true);
          if (messageId) await ackSelection(deps, cb, `Re-run ${parsed.chain} — unknown chain`);
          return 'ch:unknown';
        }
        spawnPaLogged('pa', ['chain', 'run', parsed.chain], deps.botCwd, { chain: parsed.chain });
        await answerCallbackQuery(deps.token, cb.id, `🔁 Re-running ${parsed.chain}`);
        if (messageId) await ackSelection(deps, cb, `Chain ${parsed.chain} re-run started`);
        return 'ch:started';
      }

      case 'wt': {
        // WP-D2 B.7 (2026-09-02): re-register a terminal watch — idempotent and
        // side-effect-light (a fresh watch row), so no two-tap.
        spawnPaLogged('pa', ['watch', 're-register', parsed.watchId], deps.botCwd, { watchId: parsed.watchId });
        await answerCallbackQuery(deps.token, cb.id, '🔁 Re-registering…');
        if (messageId) await ackSelection(deps, cb, `Re-register watch ${parsed.watchId}`);
        return 'wt:re-registered';
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
