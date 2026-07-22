import type {
  ConversationState,
  PAMeta,
  ModelStatusReasonCode,
  ModelStatusSnapshot,
} from './types.js';
import { toIST, todayIST, formatIST } from '../../../pa/dist/src/ist.js';
import { getSkillTranslationPatterns } from '../../../pa/dist/src/lib/skill-translations.js';
import {
  TUNABLE_TIER_LABELS,
  declaredValues,
  normalizeTunableName,
  setWorkerTunable,
  type ResolvedTunable,
  type TunableValidation,
} from '../../../pa/dist/src/lib/tunables.js';
import { BOT_COMMANDS } from './commands.js';

export interface WorkerResult {
  success: boolean;
  output: string;
  error?: string;
  evaluatorSummary?: string; // user-facing summary from LLM evaluator when worker is killed
}

export const MODEL_SWITCH_PATTERN = /^\/models?(?:@\w+)?\s+(claude|gemini|zclaude|codex|agy)\b/i;
export const DEFAULT_SWITCH_PATTERN = /^\/default(?:@\w+)?(?:\s+(claude|gemini|zclaude|codex|agy))?$/i;
export const CODE_PATTERN = /^\/code(?:@\w+)?(?:\s+(.+))?$/i;
export const RESET_PATTERN = /^\/reset(?:@\w+)?$/i;
export const NEW_PATTERN = /^\/new(?:@\w+)?(?:\s+(.+))?$/i;
export const STATUS_PATTERN = /^\/status(?:@\w+)?$/i;
export const KEEP_AWAKE_PATTERN = /^\/keepawake(?:@\w+)?$/i;
export const SKILLS_PATTERN = /^\/skills(?:@\w+)?$/i;
export const AUTH_PATTERN = /^\/auth(?:@\w+)?\s+(\S+)(?:\s+(\S+))?$/i;
export const HELP_PATTERN = /^\/help(?:@\w+)?$/i;

// --- Worker tunables: /llm, /effort, /default <setting> [value] -------------
// `/model` deliberately stays what it has always been (pick the CLI). These are
// the uniform knobs that work the same way whichever CLI is active; the
// per-worker differences (flag name, arg shape, vocabulary) live in config.yaml
// and are resolved by pa/src/lib/tunables.ts.
export const LLM_PATTERN = /^\/llm(?:@\w+)?(?:\s+([\s\S]+))?$/i;
export const EFFORT_PATTERN = /^\/effort(?:@\w+)?(?:\s+([\s\S]+))?$/i;
// Extends the EXISTING /default surface rather than inventing a parallel idiom.
// Only reachable for a non-worker first token: DEFAULT_SWITCH_PATTERN (anchored
// to the worker names) is checked first and wins, so `/default agy` still means
// "make agy this topic's default worker".
export const DEFAULT_TUNABLE_PATTERN = /^\/default(?:@\w+)?\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]+))?$/i;

export interface StatusCardArgs {
  snapshot: ModelStatusSnapshot;
  keepAwake: {
    active: boolean;
    since?: string;
  };
}

const FALLBACK_DEFAULT_WORKER = 'claude';

const MODEL_STATUS_REASON_TEXT: Record<ModelStatusReasonCode, string> = {
  default_active: 'Using the configured default worker.',
  user_override: 'Temporary user override until IST midnight.',
  user_selected_default: 'User selected the default worker explicitly.',
  default_changed: 'Topic default updated.',
  failover: 'Temporary failover due to worker availability.',
  recovery: 'Recovered to the configured worker.',
  midnight_reset: 'Temporary override expired at IST midnight.',
  reset: 'Topic reset cleared the temporary override.',
};

export function resolveEffectiveDefaultWorker(
  topicDefault: string | undefined,
  workers: Array<{ name: string }> | string[]
): string {
  const workerNames = workers
    .map((worker) => typeof worker === 'string' ? worker : worker.name)
    .filter((worker): worker is string => !!worker);

  if (topicDefault && workerNames.includes(topicDefault)) return topicDefault;
  return workerNames[0] ?? topicDefault ?? FALLBACK_DEFAULT_WORKER;
}

function inferLegacyReasonCode(state: ConversationState, defaultWorker: string): ModelStatusReasonCode {
  if (state.preferred_worker) {
    return state.preferred_worker === defaultWorker ? 'user_selected_default' : 'user_override';
  }
  if (state.pinned_worker && state.pinned_worker !== defaultWorker) return 'failover';
  return 'default_active';
}

export function buildModelStatusSnapshot(args: {
  currentWorker?: string;
  defaultWorker: string;
  reasonCode: ModelStatusReasonCode;
  changedAt?: string;
  reasonText?: string;
}): ModelStatusSnapshot {
  const currentWorker = args.currentWorker ?? args.defaultWorker;
  return {
    current_worker: currentWorker,
    default_worker: args.defaultWorker,
    reason_code: args.reasonCode,
    reason_text: args.reasonText ?? MODEL_STATUS_REASON_TEXT[args.reasonCode],
    changed_at: args.changedAt ?? new Date().toISOString(),
  };
}

export function hydrateModelStatus(
  state: ConversationState,
  defaultWorker: string
): ModelStatusSnapshot {
  if (state.model_status) {
    return {
      current_worker: state.model_status.current_worker || state.preferred_worker || state.pinned_worker || defaultWorker,
      default_worker: defaultWorker,
      reason_code: state.model_status.reason_code,
      reason_text: state.model_status.reason_text || MODEL_STATUS_REASON_TEXT[state.model_status.reason_code],
      changed_at: state.model_status.changed_at || state.preferred_worker_set_at || new Date().toISOString(),
    };
  }

  return buildModelStatusSnapshot({
    currentWorker: state.preferred_worker || state.pinned_worker || defaultWorker,
    defaultWorker,
    reasonCode: inferLegacyReasonCode(state, defaultWorker),
    changedAt: state.preferred_worker_set_at,
  });
}

export function modelStatusNeedsRefresh(
  previous: ModelStatusSnapshot | undefined,
  next: ModelStatusSnapshot
): boolean {
  if (!previous) return true;
  return previous.current_worker !== next.current_worker
    || previous.default_worker !== next.default_worker
    || previous.reason_code !== next.reason_code
    || previous.reason_text !== next.reason_text;
}

/**
 * Render a unified status card (📌) showing both topic-scoped model state
 * and machine-wide keep-awake state.
 */
export function renderStatusCard(args: StatusCardArgs): string {
  const { snapshot, keepAwake } = args;
  const lines = [
    '📌 Topic Status',
    `Default: ${snapshot.default_worker}`,
    `Current: ${snapshot.current_worker}`,
    `Reason: ${snapshot.reason_text}`,
    keepAwake.active
      ? `Keep-awake: on${keepAwake.since ? ` since ${keepAwake.since}` : ''}`
      : 'Keep-awake: off',
  ];
  return lines.join('\n');
}

// Built dynamically from ~/.pa/codex-skill-translations.json (same source of truth
// as pa/src/worker-exec.ts's codex translation layer). Falls back to embedded
// defaults if file missing. Restart required after editing the JSON.
export const PASS_THROUGH_PATTERN = new RegExp(
  `^\\/(${getSkillTranslationPatterns().join('|')})(?:@\\w+)?\\b`,
  'i',
);
export const BRANCH_PATTERN   = /^\/branch(?:@\w+)?\s+(\S.*)/i;
export const CHILD_OF_PATTERN = /^\/child[-_]of(?:@\w+)?\s+(.+)$/i;
export const MERGE_PATTERN    = /^\/merge(?:@\w+)?$/i;
// Env-driven base for resolving short folder names in /code commands.
// User sets PA_REPOS_BASE to wherever their repos live (e.g. ~/code).
// If unset, /code <relative> requires an absolute path — no auto-prefix.
export const REPOS_BASE = process.env.PA_REPOS_BASE || '';

/**
 * Resolve a /code path argument.
 * If it looks like an absolute path (starts with a drive letter or /), return as-is.
 * Otherwise treat it as a top-level folder name under REPOS_BASE.
 * If REPOS_BASE is empty (env var unset), return the raw input — caller will
 * see a non-absolute path and can decide how to handle it.
 */
export function resolveCodePath(raw: string): string {
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) return raw;
  if (!REPOS_BASE) return raw;
  return `${REPOS_BASE}/${raw}`;
}

export interface CodeCommandResult {
  matched: boolean;
  action: 'none' | 'show' | 'reset' | 'set';
  response: string;    // ready-to-send response for 'show' and 'reset' actions
  path?: string;       // parsed path for 'set' action
  instruction?: string; // optional trailing instruction for 'set' action
}

/**
 * Parse a /code argument into a path and optional trailing instruction.
 * Handles quoted paths: /code "C:/code/some project" do something
 * Unquoted: first whitespace-delimited token is path, rest is instruction.
 */
export function parseCodeArgs(arg: string): { path: string; rest: string } {
  if (arg.startsWith('"')) {
    const closeQuote = arg.indexOf('"', 1);
    if (closeQuote > 1) {
      return {
        path: arg.slice(1, closeQuote),
        rest: arg.slice(closeQuote + 1).trim(),
      };
    }
  }
  const spaceIdx = arg.indexOf(' ');
  if (spaceIdx === -1) return { path: arg, rest: '' };
  return { path: arg.slice(0, spaceIdx), rest: arg.slice(spaceIdx + 1).trim() };
}

/**
 * Handle the /code command — set, show, or reset the per-topic working directory override.
 *
 * /code             → show current cwd_override (or default)
 * /code reset       → clear cwd_override and invalidate session
 * /code <path>      → action:'set', path returned for caller to validate and apply
 * /code <path> <instruction> → action:'set', path + instruction returned
 *
 * Path validation (stat check) is intentionally left to the caller (main.ts) to keep
 * this function pure and easily testable.
 */
export function handleCodeCommand(state: ConversationState, userText: string): CodeCommandResult {
  const match = CODE_PATTERN.exec(userText);
  if (!match) return { matched: false, action: 'none', response: '' };

  const arg = match[1]?.trim();

  // Default cwd label — mirror main.ts's BOT_CWD resolution (env-first, then process.cwd()).
  const defaultCwd = process.env.BOT_CWD || process.cwd();

  // /code with no args: show current cwd
  if (!arg) {
    const current = state.cwd_override ?? `default (${defaultCwd})`;
    return { matched: true, action: 'show', response: `Current working directory: \`${current}\`` };
  }

  // /code reset: clear override and invalidate session
  if (arg.toLowerCase() === 'reset') {
    const had = !!state.cwd_override;
    state.cwd_override = undefined;
    state.session = undefined;
    return {
      matched: true,
      action: 'reset',
      response: had
        ? `Cleared folder scope. Back to default (${defaultCwd}).`
        : 'Already using default working directory.',
    };
  }

  // /code <path> [instruction]
  const { path: rawPath, rest } = parseCodeArgs(arg);
  const path = resolveCodePath(rawPath);
  return {
    matched: true,
    action: 'set',
    response: '',
    path,
    instruction: rest || undefined,
  };
}

export function handleDefaultQuery(userText: string): { matched: boolean; worker?: string } {
  const match = DEFAULT_SWITCH_PATTERN.exec(userText);
  if (!match) return { matched: false };
  return { matched: true, worker: match[1]?.toLowerCase() };
}

/**
 * Clear conversation context (session, turns, pending action) without touching workspace
 * settings (cwd_override, preferred_worker). Called by both handleResetCommand and
 * handleNewCommand.
 */
export function clearTopicContext(state: ConversationState): void {
  state.session = undefined;
  state.pending_action = undefined;
  state.pendingDescription = undefined;
  state.turns = [];
  // Session-tier tunables (/llm, /effort) die with the conversation they were
  // set for. Topic-tier defaults (`/default <setting> <value>`) survive both
  // /reset and /new — see clearSessionTunables for the reasoning.
  clearSessionTunables(state);
}

export function handleResetCommand(state: ConversationState): { matched: boolean; response: string } {
  clearTopicContext(state);
  state.preferred_worker = undefined;
  state.preferred_worker_set_at = undefined;
  state.cwd_override = undefined;
  return { matched: true, response: '🔄 Conversation and session cleared for this topic.' };
}

/**
 * Handle the /new command. Clears conversation context but preserves workspace settings
 * (cwd_override, preferred_worker). Returns the optional instruction text if provided.
 *
 * /new              → clear context, reply "Context cleared."
 * /new <instruction> → clear context, dispatch <instruction> with fresh session
 */
export function handleNewCommand(
  state: ConversationState,
  userText: string
): { matched: boolean; instruction?: string } {
  const match = NEW_PATTERN.exec(userText);
  if (!match) return { matched: false };
  clearTopicContext(state);
  const instruction = match[1]?.trim() || undefined;
  return { matched: true, instruction };
}

export function handleHelpCommand(): { matched: boolean; response: string } {
  const helpText = BOT_COMMANDS.map(c => `/${c.command} — ${c.description}`).join('\n');
  return { matched: true, response: `*Available Commands*\n\n${helpText}` };
}

export function isPassThroughCommand(userText: string): boolean {
  return PASS_THROUGH_PATTERN.test(userText);
}

/**
 * Handle the /branch command. Validates the branch name.
 * Pure — no state mutation, no I/O. Topic creation is done in main.ts.
 */
export function handleBranchCommand(
  _state: ConversationState,
  userText: string
): { matched: boolean; branchName?: string; response: string } {
  const match = BRANCH_PATTERN.exec(userText);
  if (!match) return { matched: false, response: '' };

  const name = match[1].trim();
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(name)) {
    return {
      matched: true,
      response: 'Branch name must be 1–50 alphanumeric, dash, or underscore characters.',
    };
  }

  return { matched: true, branchName: name, response: '' };
}

/**
 * Handle the /child-of command. Validates and extracts the parent name.
 * Parent lookup (async) is handled by the caller (main.ts).
 * Pure — no state mutation, no I/O.
 */
export function handleChildOfCommand(
  state: ConversationState,
  userText: string
): { matched: boolean; parentName?: string; response: string } {
  const match = CHILD_OF_PATTERN.exec(userText);
  if (!match) return { matched: false, response: '' };

  // Block re-link only when an active (un-merged) branch relationship exists.
  // After a merge (mergedAt is set), re-linking to a new parent is allowed.
  if (state.ancestry && !state.ancestry.mergedAt) {
    return {
      matched: true,
      parentName: undefined,
      response: `Already a branch of *${state.ancestry.branchName}*. Use /merge to close first.`,
    };
  }

  const parentName = match[1].trim();
  if (!parentName) {
    return { matched: true, parentName: undefined, response: 'Parent topic name cannot be empty.' };
  }
  return { matched: true, parentName, response: '' };
}

/**
 * Handle the /merge command. Validates ancestry state.
 * Actual turn copying is handled by the caller (main.ts).
 * Pure — no state mutation, no I/O.
 */
export function handleMergeCommand(
  state: ConversationState,
  userText: string
): { matched: boolean; response: string } {
  if (!MERGE_PATTERN.test(userText)) return { matched: false, response: '' };

  if (!state.ancestry) {
    return {
      matched: true,
      response: 'No parent branch. Use /child-of <parent_name> to link this topic first.',
    };
  }

  if (state.ancestry.mergedAt) {
    const mergedIST = formatIST(new Date(state.ancestry.mergedAt));
    return { matched: true, response: `Already merged at ${mergedIST}.` };
  }

  return { matched: true, response: '' };
}

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

export function getModelSwitchTarget(userText: string): string | undefined {
  const match = MODEL_SWITCH_PATTERN.exec(userText);
  return match?.[1]?.toLowerCase();
}

export function handleModelSwitch(
  state: ConversationState,
  userText: string
): { switched: boolean; response: string } {
  const model = getModelSwitchTarget(userText);
  if (!model) return { switched: false, response: '' };
  state.preferred_worker = model;
  state.preferred_worker_set_at = new Date().toISOString();
  state.session = undefined;
  return { switched: true, response: `Switched to ${model} (until midnight IST).` };
}

/**
 * Expire a /model override if it was set on a previous IST calendar day.
 * Returns true if the override was cleared, false if no change.
 */
export function expirePreferredWorker(state: ConversationState): boolean {
  if (!state.preferred_worker || !state.preferred_worker_set_at) return false;

  const setAtIST = toIST(new Date(state.preferred_worker_set_at)).toISOString().slice(0, 10);
  const today = todayIST();

  if (setAtIST !== today) {
    state.preferred_worker = undefined;
    state.preferred_worker_set_at = undefined;
    state.session = undefined;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Worker tunables — /llm, /effort, and the /default <setting> extension
//
// ONE bot-level command per knob, whichever CLI is active. The bot word maps to
// a config SETTING NAME (`/llm` -> `model`), and the worker's own `tunables:`
// block in config.yaml supplies the arg template. Two rules drive everything
// here:
//   STRICT ON THE KNOB — an unknown setting, or one this worker does not
//   declare, is rejected at command time with the list of what it DOES support.
//   Validating at dispatch time instead would put a flag the CLI rejects on
//   EVERY run in the topic, which reads as an outage, not a settings mistake.
//   FREE ON THE VALUE — a value is never rejected. Model names move faster than
//   any allowlist (agy went "Gemini 3.5 Flash" -> "3.6 Flash" in an afternoon),
//   so `values:` is a display hint; an unrecognised value is passed through with
//   a note. Do not turn declaredValues() into a gate.
// ---------------------------------------------------------------------------

/**
 * Bot command word -> config setting name.
 *
 * `/llm` is the uniform user-facing word; `model` is what the CLIs call the
 * knob (and therefore what config.yaml declares). `/model` is NOT in this map —
 * it keeps its existing meaning of choosing the CLI.
 */
export const TUNABLE_COMMAND_SETTINGS: Record<string, string> = {
  llm: 'model',
  effort: 'effort',
};

/** Words that mean "unset this tier and fall through to the next one". */
export const TUNABLE_CLEAR_TOKENS = new Set(['clear', 'reset', 'default', 'unset', '-']);

export type TunableScope = 'session' | 'topic';
export type TunableAction = 'show' | 'set' | 'clear';

export interface TunableCommand {
  scope: TunableScope;   // session = /llm|/effort (expires at IST midnight); topic = /default (persistent)
  setting: string;       // normalized CONFIG setting name, e.g. 'model'
  label: string;         // the word the user typed, echoed back in help text ('llm', 'effort', …)
  action: TunableAction;
  value?: string;        // present for action === 'set'
}

/**
 * Parse /llm, /effort and `/default <setting> [value]` into one shape.
 *
 * Deliberately order-independent: `/default <worker>` is excluded here (not just
 * by call order in main.ts) so this function can never hijack the worker form.
 * Returns undefined when the text is not a tunable command at all.
 */
export function parseTunableCommand(userText: string): TunableCommand | undefined {
  const text = userText.trim();

  const build = (scope: TunableScope, label: string, setting: string, rawValue: string | undefined): TunableCommand => {
    const value = rawValue?.trim();
    if (!value) return { scope, label, setting, action: 'show' };
    if (TUNABLE_CLEAR_TOKENS.has(value.toLowerCase())) return { scope, label, setting, action: 'clear' };
    return { scope, label, setting, action: 'set', value };
  };

  const llm = LLM_PATTERN.exec(text);
  if (llm) return build('session', 'llm', TUNABLE_COMMAND_SETTINGS['llm']!, llm[1]);

  const effort = EFFORT_PATTERN.exec(text);
  if (effort) return build('session', 'effort', TUNABLE_COMMAND_SETTINGS['effort']!, effort[1]);

  if (DEFAULT_SWITCH_PATTERN.test(text)) return undefined;   // `/default agy` — the worker form owns this
  const def = DEFAULT_TUNABLE_PATTERN.exec(text);
  if (def) {
    const label = def[1].toLowerCase();
    // A WORKER NAME always belongs to the worker-switch form, even with
    // trailing text. Fixed 2026-07-22: DEFAULT_SWITCH_PATTERN is end-anchored
    // ("/default agy" only, nothing after), so `/default agy can you check
    // the logs` fell through to here, which previously accepted ANY
    // word-like first token — rejecting a worker name as if it were an
    // unrecognized setting, where before this feature existed the whole
    // message reached the LLM as ordinary chat. Re-use MODEL_SWITCH_PATTERN's
    // worker list so this can't drift from the worker-switch form it defers
    // to. A genuinely unknown word (not a worker name) still becomes a
    // TunableCommand and gets handleTunableCommand's helpful "no setting
    // called '<x>'" rejection — that behavior is deliberate and tested
    // (e.g. "/default temperature 0.7") and must not be suppressed too.
    if (/^(claude|gemini|zclaude|codex|agy)$/i.test(label)) return undefined;
    const setting = TUNABLE_COMMAND_SETTINGS[label] ?? normalizeTunableName(label);
    return build('topic', label, setting, def[2]);
  }

  return undefined;
}

/** Stamp key for one session override. Worker names never contain ':'. */
export function tunableStampKey(worker: string, setting: string): string {
  return `${worker}:${normalizeTunableName(setting)}`;
}

/**
 * Set (or clear, with value undefined/blank) a SESSION-tier tunable and stamp it
 * with the time it was set, so it can expire on its own IST day boundary.
 */
export function setSessionTunable(
  state: ConversationState,
  worker: string,
  setting: string,
  value: string | undefined,
  nowIso: string = new Date().toISOString(),
): void {
  const name = normalizeTunableName(setting);
  const next = setWorkerTunable(state.tunable_overrides, worker, name, value);
  state.tunable_overrides = Object.keys(next).length > 0 ? next : undefined;

  const stamps = { ...(state.tunable_overrides_set_at ?? {}) };
  const key = tunableStampKey(worker, name);
  if (value && value.trim()) stamps[key] = nowIso;
  else delete stamps[key];
  state.tunable_overrides_set_at = Object.keys(stamps).length > 0 ? stamps : undefined;
}

/** Set (or clear) a TOPIC-tier tunable. Persistent — no stamp, never expires. */
export function setTopicTunable(
  state: ConversationState,
  worker: string,
  setting: string,
  value: string | undefined,
): void {
  const next = setWorkerTunable(state.tunable_defaults, worker, normalizeTunableName(setting), value);
  state.tunable_defaults = Object.keys(next).length > 0 ? next : undefined;
}

/**
 * Expire session-tier tunables set on a previous IST calendar day — the same
 * lifecycle as preferred_worker, but evaluated PER ENTRY so that setting one
 * knob today cannot extend the life of another set yesterday.
 *
 * An entry with a missing or unparseable stamp is expired rather than kept: a
 * temporary override whose provenance cannot be proven is exactly the thing this
 * tier exists to bound, and every writer (setSessionTunable) always stamps.
 * Returns the `<worker>:<setting>` keys that were cleared, for logging.
 */
export function expireTunableOverrides(state: ConversationState): string[] {
  const store = state.tunable_overrides;
  if (!store || Object.keys(store).length === 0) {
    if (state.tunable_overrides_set_at) state.tunable_overrides_set_at = undefined;  // orphaned stamps
    return [];
  }

  const today = todayIST();
  const stamps = state.tunable_overrides_set_at ?? {};
  const stale: Array<{ worker: string; setting: string; key: string }> = [];

  for (const [worker, slice] of Object.entries(store)) {
    for (const setting of Object.keys(slice ?? {})) {
      const key = tunableStampKey(worker, setting);
      const setAt = stamps[key];
      let day: string | undefined;
      if (setAt) {
        const parsed = new Date(setAt);
        if (!Number.isNaN(parsed.getTime())) day = toIST(parsed).toISOString().slice(0, 10);
      }
      if (day !== today) stale.push({ worker, setting, key });
    }
  }

  for (const entry of stale) setSessionTunable(state, entry.worker, entry.setting, undefined);
  return stale.map((entry) => entry.key);
}

/**
 * Drop every session-tier tunable. Called from clearTopicContext, i.e. by both
 * /reset and /new: a session override belongs to the conversation being thrown
 * away. Topic defaults are deliberately NOT touched — they are this topic's
 * persistent configuration, the exact analogue of `/default <worker>`, which
 * already survives /reset (it lives in config.yaml and is never cleared here).
 */
export function clearSessionTunables(state: ConversationState): boolean {
  const had = !!state.tunable_overrides && Object.keys(state.tunable_overrides).length > 0;
  state.tunable_overrides = undefined;
  state.tunable_overrides_set_at = undefined;
  return had;
}

function formatTunableValue(resolved: ResolvedTunable | undefined): string {
  return resolved?.value ?? '(none — the CLI picks)';
}

/**
 * Explain a `supersedes:` resolution instead of applying it silently.
 *
 * A setting can be SET and still contribute nothing, when the worker's config
 * declares another setting supersedes it (agy: the effort is baked into the
 * model name, and its Claude-family models reject --effort outright). Dropping
 * the user's value with no word said is the same class of bug as the one the
 * rule fixes — invisible behaviour that only shows up as "why did nothing
 * change?". Both directions are rendered, so whichever knob the user asks about
 * tells the same story. The WHY is deliberately not spelled out here: it is
 * per-worker CLI knowledge and lives in that setting's config description,
 * which renderTunableReport already prints.
 */
function supersedeNotes(resolved: ResolvedTunable | undefined): string[] {
  if (!resolved) return [];
  const notes: string[] = [];
  if (resolved.supersededBy) {
    const winner = resolved.supersededByValue
      ? `\`${resolved.supersededBy}\` (${resolved.supersededByValue})`
      : `\`${resolved.supersededBy}\``;
    notes.push(
      `⚠️ Set, but NOT passed to the CLI: ${winner} supersedes \`${resolved.setting}\` on this worker (config.yaml). ` +
      `Clear the ${resolved.supersededBy} to use it again.`,
    );
  }
  for (const loser of resolved.superseding ?? []) {
    notes.push(`Note: \`${loser}\` is set but NOT passed while \`${resolved.setting}\` is — it supersedes it here.`);
  }
  return notes;
}

export interface TunableReportInput {
  worker: string;
  label: string;                    // command word to echo in the "set with" hints
  setting: string;                  // config setting name
  validation: TunableValidation;    // from validateTunable — carries the rejection text
  resolved?: ResolvedTunable;       // from resolveTunable; undefined when unsupported
  observed?: string[];              // values mined from run history (tunables-observed.ts)
  sessionValue?: string;            // what the session tier currently holds, if anything
  topicValue?: string;              // what the topic tier currently holds, if anything
  pinned?: string[];                // value(s) already baked into the worker's STATIC args in config.yaml
}

/**
 * The discoverability surface: the reply to a bare /llm or /effort.
 *
 * Answers three questions in one message — what is in effect, WHICH TIER put it
 * there, and what this worker accepts (declared hints plus values actually seen
 * in past runs, kept visibly separate because the declared list is hand-written
 * and the observed list is not).
 */
export function renderTunableReport(input: TunableReportInput): string {
  if (!input.validation.ok) {
    return input.validation.error ?? `Worker '${input.worker}' has no setting called '${input.setting}'.`;
  }

  const spec = input.resolved?.spec;
  const tier = input.resolved?.tier ?? 'cli';
  // A value can also be PINNED in the worker's static args (claude/zclaude ship
  // `--model opusplan`). Reporting "nothing is passed" there would be a lie in
  // the one place the user came to get a straight answer, so surface it — it is
  // still tier 'cli' as far as the cascade is concerned, because nothing the
  // cascade owns is set.
  const pinned = (input.pinned ?? []).filter(Boolean);
  const pinnedApplies = tier === 'cli' && pinned.length > 0;
  const lines: string[] = [
    `*${input.setting}* on ${input.worker}`,
    `Current: ${pinnedApplies ? pinned[0] : formatTunableValue(input.resolved)}`,
    `Set by: ${pinnedApplies ? "this worker's fixed args in config.yaml" : TUNABLE_TIER_LABELS[tier]}`,
  ];

  // Before anything else: if what is "current" is not actually reaching the CLI,
  // say so — that is the one thing the user came here to find out.
  lines.push(...supersedeNotes(input.resolved));

  // Deliberately NOT wrapped in _italics_: the description is free text from
  // config.yaml and may contain underscores (`model_reasoning_effort=`). Inside
  // an italic span an odd number of them unbalances the whole message and
  // Telegram rejects it with a 400; as plain text the MarkdownV2 sanitizer just
  // escapes the stray one.
  if (spec?.description) lines.push(spec.description);

  const declared = declaredValues(spec);
  lines.push(declared.length > 0
    ? `Known values: ${declared.join(', ')}`
    : 'Known values: none declared — any value is accepted.');

  const observed = (input.observed ?? []).filter(
    (v) => v && !declared.some((d) => d.toLowerCase() === v.toLowerCase()),
  );
  if (observed.length > 0) lines.push(`Seen in past runs: ${observed.join(', ')}`);

  const tiers: string[] = [];
  if (input.sessionValue) tiers.push(`session: ${input.sessionValue}`);
  if (input.topicValue) tiers.push(`topic default: ${input.topicValue}`);
  if (spec?.default) tiers.push(`worker default: ${spec.default}`);
  if (tiers.length > 0) lines.push(`Tiers: ${tiers.join(' · ')}`);

  lines.push(
    `Set: /${input.label} <value> · Clear: /${input.label} clear · Persist: /default ${input.label} <value>`,
  );
  return lines.join('\n');
}

export interface TunableSetResultInput {
  worker: string;
  setting: string;
  scope: TunableScope;
  value: string;
  known: boolean;             // isKnownValue(spec, value) — a NOTE, never a rejection
  args: string[];             // exactly what will be appended to the worker command
  resolved?: ResolvedTunable; // resolution AFTER the set — carries any supersede outcome
}

export function renderTunableSetResult(input: TunableSetResultInput): string {
  const lifetime = input.scope === 'session'
    ? 'until midnight IST'
    : 'topic default — persists';
  const lines = [`${input.setting} → *${input.value}* on ${input.worker} (${lifetime}).`];
  if (!input.known) {
    lines.push(`⚠️ Not a known value for ${input.worker} — passing through anyway.`);
  }
  // Accepting the value and then quietly not sending it (or quietly dropping a
  // sibling setting the user set earlier) would make this reply a lie.
  lines.push(...supersedeNotes(input.resolved));
  if (input.args.length > 0) lines.push(`Args: \`${input.args.join(' ')}\``);
  return lines.join('\n');
}

export interface TunableClearResultInput {
  worker: string;
  setting: string;
  scope: TunableScope;
  resolved?: ResolvedTunable;   // resolution AFTER the clear — what it falls back to
  pinned?: string[];            // value baked into the worker's static args, if any
}

export function renderTunableClearResult(input: TunableClearResultInput): string {
  const tier = input.resolved?.tier ?? 'cli';
  const scopeLabel = input.scope === 'session' ? 'session override' : 'topic default';
  const pinned = (input.pinned ?? []).filter(Boolean);
  // Same honesty rule as the report: falling back to "nothing" still means
  // `--model opusplan` on a worker that pins one in config.yaml.
  const now = tier === 'cli' && pinned.length > 0
    ? `${pinned[0]} (this worker's fixed args in config.yaml)`
    : `${formatTunableValue(input.resolved)} (${TUNABLE_TIER_LABELS[tier]})`;
  return `Cleared ${scopeLabel} for ${input.setting} on ${input.worker}.\nNow: ${now}.`;
}

/**
 * Parse and strip the [PA_META] envelope from worker output.
 */
export function parseMetadata(output: string, executionMode = false): { cleaned: string; meta: PAMeta | null } {
  const withMeta = (cleaned: string, meta: PAMeta | null) =>
    ({ cleaned, meta: executionMode ? null : meta });

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

  const firstAttempt = tryParseMeta(jsonStr);
  if (firstAttempt !== undefined) return withMeta(cleaned, firstAttempt);

  const lastBrace = jsonStr.lastIndexOf('}');
  if (lastBrace >= 0) {
    const trailing = jsonStr.slice(lastBrace + 1).trim();
    const isArtifactOnly = trailing === '' || /^<\/?\w[\w-]*>$/.test(trailing);
    if (isArtifactOnly) {
      const candidate = jsonStr.slice(0, lastBrace + 1);
      const secondAttempt = tryParseMeta(candidate);
      if (secondAttempt !== undefined) return withMeta(cleaned, secondAttempt);
      return withMeta(cleaned, null);
    }
  }

  if (jsonStr.endsWith('}')) return withMeta(cleaned, null);
  return withMeta(output, null);
}

/**
 * Apply PA_META actions and the text-based CONFIRMATION_PATTERN to a worker response.
 */
export function applyMetaActions(
  response: string,
  meta: PAMeta | null,
  state: ConversationState
): { response: string; skillToRun: string | null; restartBot: boolean } {
  let out = response;
  let restartBot = false;

  if (meta?.actions.some((a) => a.type === 'restart_bot')) {
    restartBot = true;
    out += `\n\n_(Restarting bot for deployment...)_`;
  }

  if (CONFIRMATION_PATTERN.test(out)) {
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
        return { response: out, skillToRun: null, restartBot };
      }
      out += `\n\n_(Triggering skill: ${skillName})_`;
      return { response: out, skillToRun: skillName, restartBot };
    }
  }

  return { response: out, skillToRun: null, restartBot };
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
export function buildWorkerResponse(result: WorkerResult, worker: string): string {
  if (result.success && result.output.trim()) {
    let output = result.output.trim();

    if (worker === 'gemini' || worker === 'agy') {
      const thoughtRegex = /\[Thought: true\]([\s\S]*?)\[Thought: false\]/g;
      const blocks: string[] = [];
      let match;
      while ((match = thoughtRegex.exec(output)) !== null) {
        const content = match[1].trim();
        if (content) blocks.push(content);
      }
      if (blocks.length > 0) return normalizeMarkdown(blocks[blocks.length - 1]);
      output = output.replace(/\[Thought: (true|false)\]/g, '').trim();
    } else {
      output = output.replace(/<thought>[\s\S]*?<\/thought>\s*/gi, '');
      output = output.replace(/<\/?thought>/gi, '').trim();
    }

    output = output.replace(
      /^(\*\*[A-Z][^*\n]+\*\*\s+(?:I'(?:ve|m)|I will|I'll|My )[^\n]*\n+)+/,
      ''
    ).trim();

    const noisePrefixes = [
      /^(\*+(Planning|Strategy|Research|Thought|Process)\*+:?\s*)+/i,
      /^(Planning\.\.\.|Strategy:|Research:|Thought:)\s*/i,
    ];

    for (const pattern of noisePrefixes) {
      output = output.replace(pattern, '').trim();
    }

    if (isNoOutputSentinel(output)) return '';

    return normalizeMarkdown(output);
  }

  if (!result.success) {
    if (result.evaluatorSummary?.trim()) return result.evaluatorSummary.trim();
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
    ? `Try again, or switch with /model ${suggestedWorker}.`
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
