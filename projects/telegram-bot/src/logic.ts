import * as os from 'os';
import type {
  ConversationState,
  ModelStatusReasonCode,
  ModelStatusSnapshot,
} from './types.js';
import { toIST, todayIST, formatIST } from '../../../pa/dist/src/ist.js';
import { getSkillTranslationPatterns } from '../../../pa/dist/src/lib/skill-translations.js';
export {
  KNOWN_CLI_DEFAULT_MODELS,
  resolveWorkerLlm,
  resolveWorkerEffort,
  formatWorkerDescriptor,
  selectWorkerTunables,
};
import {
  KNOWN_CLI_DEFAULT_MODELS,
  TUNABLE_TIER_LABELS,
  declaredValues,
  formatWorkerDescriptor,
  normalizeTunableName,
  resolveWorkerLlm,
  resolveWorkerEffort,
  selectWorkerTunables,
  setWorkerTunable,
  type ResolvedTunable,
  type TunableValidation,
} from '../../../pa/dist/src/lib/tunables.js';
import type { WorkerConfig } from '../../../pa/dist/src/types.js';
import { BOT_COMMANDS } from './commands.js';
import { DEBUG_PATTERN } from './debug-command.js';
import { PAIR_PATTERN } from './voice-inbox-bridge.js';
import type { ThreadRecord } from './topic-threads.js';
// removeTopicSource (remove action) + the inline-cap const for the list
// footer — legal: sources.ts imports only types.js, so no cycle.
import { removeTopicSource, TOPIC_SOURCE_INLINE_MAX_CHARS } from './sources.js';

export const AGENT_SWITCH_PATTERN = /^\/agents?(?:@\w+)?(?:\s+(claude|zclaude|codex|agyc|agy))?$/i;
export const AGENT_BARE_PATTERN = /^\/agents?(?:@\w+)?$/i;
export const MODEL_SWITCH_PATTERN = /^\/models?(?:@\w+)?\s+(claude|zclaude|codex|agyc|agy)\b/i;
export const DEFAULT_SWITCH_PATTERN = /^\/default(?:@\w+)?(?:\s+(?:agent\s+)?(claude|zclaude|codex|agyc|agy))?$/i;
export const CODE_PATTERN = /^\/code(?:@\w+)?(?:\s+(.+))?$/i;
export const SOURCES_PATTERN = /^\/sources(?:@\w+)?(?:\s+(.+))?$/i;
export const RESET_PATTERN = /^\/reset(?:@\w+)?$/i;
// [\s\S] (not .) so multi-line instructions (quoted ref + question) match — . never matches \n.
export const NEW_PATTERN = /^\/new(?:@\w+)?(?:\s+([\s\S]+))?$/i;
export const STATUS_PATTERN = /^\/status(?:@\w+)?$/i;
export const SKILLS_PATTERN = /^\/skills(?:@\w+)?$/i;
export const AUTH_PATTERN = /^\/auth(?:@\w+)?\s+(\S+)(?:\s+(\S+))?$/i;
// /secret <request-id> <value> — the provider-generic twin of /auth (auth broker
// Phase A, SPEC §3.9): delivers a secret/API-key value for a pending `pa auth`
// request. Value can contain spaces (a passphrase), hence [\s\S]+ rather than \S+.
export const SECRET_PATTERN = /^\/secret(?:@\w+)?\s+(ir-[0-9a-f]{12})\s+([\s\S]+)$/i;
export const HELP_PATTERN = /^\/help(?:@\w+)?$/i;
export const HEALTH_PATTERN = /^\/health(?:@\w+)?$/i;
export const REF_PATTERN = /^\/ref(?:@\w+)?\s+(\S+)\s*$/i;
export const CLAIMS_PATTERN = /^\/claims(?:@\w+)?$/i;
// Deterministic trigger for a Google OAuth reauth link. Local, never LLM-inferred:
// the operator asks for this precisely when four skills are already blocked, and
// the link has a 12 h fuse. `/reauth [skill]` optionally names the skill to resume.
export const REAUTH_PATTERN = /^\/reauth(?:@\w+)?(?:\s+([a-z0-9][a-z0-9-]*))?\s*$/i;
// REAUTH_CALLBACK_PATTERN + parseReauthCallback (the `reauth:google[:skill]` callback
// grammar row) moved 2026-09-02 to pa/src/lib/callback-grammar.ts — the single
// callback-grammar source (handover Wave 1 SPEC §3.4); re-exported so main.ts's and
// reauth-command.test.ts's existing imports keep working unchanged.
export { REAUTH_CALLBACK_PATTERN, parseReauthCallback } from '../../../pa/dist/src/lib/callback-grammar.js';
// [Voice message]/[Audio file]/[Video note] re-transcription (WP5 of the
// hardened voice-transcription plan). Wiring (locate the replied media,
// call voice.ts's findCachedAudio/transcribeVoiceMessage) is WP6's job in
// main.ts — this WP only owns the parser + BOT_COMMANDS registration.
export const RETRANSCRIBE_PATTERN = /^\/retranscribe(?:@\w+)?(?:\s+(\S+))?\s*$/i;

// Deterministic triggers for the granular
// phase skills (~/.pa/skills/{commit,push,push-public}/skill.md) — each independently
// invokable when the operator only wants part of the pipeline (see the skills' own
// trigger_description for the split rationale). Mutually exclusive by construction:
// each pattern's trailing `(?:@\w+)?\s*$` requires end-of-string immediately after the
// literal command name, so e.g. COMMIT_PATTERN can never match "/commit_and_push" and
// PUSH_PATTERN can never match "/push_public" — see logic.test.ts's explicit
// regression tests for this.
export const COMMIT_PATTERN = /^\/commit(?:@\w+)?\s*$/i;
export const PUSH_PATTERN = /^\/push(?:@\w+)?\s*$/i;
export const PUSH_PUBLIC_PATTERN = /^\/push_public(?:@\w+)?\s*$/i;
export const INVESTIGATE_FLAGGED_PATTERN = /^\/investigate_flagged(?:@\w+)?\s*$/i;

// Deterministic trigger for /update_brain — stages learnings for nightly topic-brain fold.
// Pattern (logic.ts, exported): /^\/update[-_]brain(?:@\w+)?(?:\s+([\s\S]+))?$/i
// — bare, with optional guidance text, both slash forms, optional @botname.
export const UPDATE_BRAIN_PATTERN = /^\/update[-_]brain(?:@\w+)?(?:\s+([\s\S]+))?$/i;

// AI-203: /orchestrator — per-topic orchestrator mode toggle + status
// (on|off|status). Definition lives here beside isKnownCommand; orchestrator.ts
// re-exports it so main.ts's interception imports from this module family
// (grep obligation: consumers import, none restates).
export const ORCHESTRATOR_PATTERN = /^\/orchestrator(?:@\w+)?(?:\s+(on|off|status))?$/i;

/**
 * Returns true if the worker's args include --append-system-prompt-file (bare or =form).
 * This determines whether the worker receives bot-instructions.md as a file.
 * Config-driven: operators add the flag to worker args in ~/.pa/config.yaml.
 */
export function workerReceivesStaticPromptFile(worker: { args?: string[] } | undefined | null): boolean {
  if (!worker?.args) return false;
  return worker.args.some(
    a => a === '--append-system-prompt-file' || a.startsWith('--append-system-prompt-file=')
  );
}

// --- Worker tunables: /model, /effort, /default <setting> [value] -------------
// `/agent` selects the agent CLI harness (agy, claude, codex, zclaude).
// `/model` sets or shows the model the active agent runs (e.g. /model gemini-3.7-flash-high).
// `/llm` is sunset in favor of /model (handled via handleSunsetLlmCommand).
export const MODEL_TUNABLE_PATTERN = /^\/models?(?:@\w+)?(?:\s+([\s\S]+))?$/i;
export const LLM_PATTERN = /^\/llm(?:@\w+)?(?:\s+([\s\S]+))?$/i;
export const EFFORT_PATTERN = /^\/effort(?:@\w+)?(?:\s+([\s\S]+))?$/i;
// Extends the EXISTING /default surface rather than inventing a parallel idiom.
// Only reachable for a non-worker first token: DEFAULT_SWITCH_PATTERN (anchored
// to the worker names) is checked first and wins, so `/default agy` or `/default agent agy`
// still means "make agy this topic's default agent".
export const DEFAULT_TUNABLE_PATTERN = /^\/default(?:@\w+)?\s+([A-Za-z][A-Za-z0-9_-]*)(?:\s+([\s\S]+))?$/i;

export interface StatusCardArgs {
  snapshot: ModelStatusSnapshot;
  /** Wave-2 executor lane (SPEC §3.1 A.3): task-lane counts. Optional — callers
   *  that don't compute them (and every pre-Wave-2 test/byte pin) render exactly
   *  as before; a zero line renders nothing, never "0 running · 0 parked · 0 queued". */
  tasks?: { running: number; parked: number; queued: number };
  /** AI-203 increment 3: orchestrator-thread counts for this topic. Optional —
   *  callers that don't compute them render exactly as before; an all-zero
   *  count renders no line, never "Threads: 0 running" (Tasks-line rule). */
  threads?: { running: number; queued: number; done: number; failed: number; cancelled: number };
}

const FALLBACK_DEFAULT_WORKER = 'claude';

const MODEL_STATUS_REASON_TEXT: Record<ModelStatusReasonCode, string> = {
  default_active: 'Using the configured default agent.',
  user_override: 'Temporary user override until IST midnight.',
  user_selected_default: 'User selected the default agent explicitly.',
  default_changed: 'Topic default updated.',
  failover: 'Temporary failover due to agent availability.',
  recovery: 'Recovered to the configured agent.',
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
  currentLlm?: string;
  defaultLlm?: string;
  currentEffort?: string;
  defaultEffort?: string;
}): ModelStatusSnapshot {
  let defaultWorker = args.defaultWorker;
  let currentWorker = args.currentWorker ?? defaultWorker;

  return {
    current_worker: currentWorker,
    default_worker: defaultWorker,
    reason_code: args.reasonCode,
    reason_text: args.reasonText ?? MODEL_STATUS_REASON_TEXT[args.reasonCode],
    changed_at: args.changedAt ?? new Date().toISOString(),
    ...(args.currentLlm ? { current_llm: args.currentLlm } : {}),
    ...(args.defaultLlm ? { default_llm: args.defaultLlm } : {}),
    ...(args.currentEffort ? { current_effort: args.currentEffort } : {}),
    ...(args.defaultEffort ? { default_effort: args.defaultEffort } : {}),
  };
}

export function hydrateModelStatus(
  state: ConversationState,
  defaultWorker: string,
  workersOrConfig?: { workers?: WorkerConfig[] } | WorkerConfig[]
): ModelStatusSnapshot {
  const workers = Array.isArray(workersOrConfig)
    ? workersOrConfig
    : workersOrConfig?.workers;
  let normDefaultWorker = defaultWorker;

  let candidateWorker = state.model_status?.current_worker || state.preferred_worker || state.pinned_worker || normDefaultWorker;
  const knownWorkers = workers?.map((w) => w.name) ?? [];
  const currentWorker = (knownWorkers.length > 0 && !knownWorkers.includes(candidateWorker))
    ? normDefaultWorker
    : candidateWorker;

  const currentWorkerConfig = workers?.find((w) => w.name === currentWorker);
  const currentLlm = (currentWorkerConfig
    ? resolveWorkerLlm(currentWorkerConfig, selectWorkerTunables(state.tunable_overrides, currentWorker), selectWorkerTunables(state.tunable_defaults, currentWorker))
    : undefined) ?? state.model_status?.current_llm;
  const currentEffort = (currentWorkerConfig
    ? resolveWorkerEffort(currentWorkerConfig, selectWorkerTunables(state.tunable_overrides, currentWorker), selectWorkerTunables(state.tunable_defaults, currentWorker))
    : undefined) ?? state.model_status?.current_effort;

  const defaultWorkerConfig = workers?.find((w) => w.name === normDefaultWorker);
  const defaultLlm = (defaultWorkerConfig
    ? resolveWorkerLlm(defaultWorkerConfig, undefined, selectWorkerTunables(state.tunable_defaults, normDefaultWorker))
    : undefined) ?? state.model_status?.default_llm;
  const defaultEffort = (defaultWorkerConfig
    ? resolveWorkerEffort(defaultWorkerConfig, undefined, selectWorkerTunables(state.tunable_defaults, normDefaultWorker))
    : undefined) ?? state.model_status?.default_effort;

  if (state.model_status) {
    return {
      current_worker: currentWorker,
      default_worker: normDefaultWorker,
      reason_code: state.model_status.reason_code,
      reason_text: state.model_status.reason_text || MODEL_STATUS_REASON_TEXT[state.model_status.reason_code],
      changed_at: state.model_status.changed_at || state.preferred_worker_set_at || new Date().toISOString(),
      ...(currentLlm ? { current_llm: currentLlm } : {}),
      ...(defaultLlm ? { default_llm: defaultLlm } : {}),
      ...(currentEffort ? { current_effort: currentEffort } : {}),
      ...(defaultEffort ? { default_effort: defaultEffort } : {}),
    };
  }

  return buildModelStatusSnapshot({
    currentWorker,
    defaultWorker: normDefaultWorker,
    reasonCode: inferLegacyReasonCode(state, normDefaultWorker),
    changedAt: state.preferred_worker_set_at,
    currentLlm,
    defaultLlm,
    currentEffort,
    defaultEffort,
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
    || previous.reason_text !== next.reason_text
    || previous.current_llm !== next.current_llm
    || previous.default_llm !== next.default_llm
    || previous.current_effort !== next.current_effort
    || previous.default_effort !== next.default_effort;
}

/**
 * Render a unified status card (📌) showing the topic-scoped model state.
 */
export function renderStatusCard(args: StatusCardArgs): string {
  const { snapshot } = args;
  const defaultLabel = formatWorkerDescriptor(snapshot.default_worker, snapshot.default_llm, snapshot.default_effort);
  const currentLabel = formatWorkerDescriptor(snapshot.current_worker, snapshot.current_llm, snapshot.current_effort);

  const lines = [
    '📌 Topic Status',
    `Default: ${defaultLabel}`,
    `Current: ${currentLabel}`,
    `Reason: ${snapshot.reason_text}`,
  ];
  if (args.tasks && (args.tasks.running > 0 || args.tasks.parked > 0 || args.tasks.queued > 0)) {
    lines.push(`Tasks: ${args.tasks.running} running · ${args.tasks.parked} parked · ${args.tasks.queued} queued`);
  }
  if (args.threads && (args.threads.running > 0 || args.threads.queued > 0 || args.threads.done > 0
    || args.threads.failed > 0 || args.threads.cancelled > 0)) {
    const parts = [
      ...(args.threads.running > 0 ? [`${args.threads.running} running`] : []),
      ...(args.threads.queued > 0 ? [`${args.threads.queued} queued`] : []),
      ...(args.threads.done > 0 ? [`${args.threads.done} done`] : []),
      ...(args.threads.failed > 0 ? [`${args.threads.failed} failed`] : []),
      ...(args.threads.cancelled > 0 ? [`${args.threads.cancelled} cancelled`] : []),
    ];
    lines.push(`Threads: ${parts.join(' · ')}`);
  }
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
// Read per call (not frozen at module init) so tests can pin it per-test.
function reposBase(): string {
  return process.env.PA_REPOS_BASE || '';
}

/**
 * Resolve a /code path argument.
 * If it looks like an absolute path (starts with a drive letter or /), return as-is.
 * Otherwise treat it as a top-level folder name under REPOS_BASE.
 * If REPOS_BASE is empty (env var unset), return the raw input — caller will
 * see a non-absolute path and can decide how to handle it.
 */
export function resolveCodePath(raw: string): string {
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) return raw;
  const base = reposBase();
  if (!base) return raw;
  return `${base}/${raw}`;
}

export interface CodeCommandResult {
  matched: boolean;
  action: 'none' | 'show' | 'reset' | 'set';
  response: string;    // ready-to-send response for 'show' and 'reset' actions
  path?: string;       // parsed path for 'set' action
  instruction?: string; // optional trailing instruction for 'set' action
}

export type UpdateBrainResult =
  | { action: 'refusal'; response: string }
  | { action: 'stage'; instruction: string; stagedPath: string; response: string };

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
export function handleCodeCommand(
  state: ConversationState,
  userText: string,
  resolvedWorkdir?: { dir: string; tier: string }
): CodeCommandResult {
  const match = CODE_PATTERN.exec(userText);
  if (!match) return { matched: false, action: 'none', response: '' };

  const arg = match[1]?.trim();

  // Default cwd label — mirror main.ts's BOT_CWD resolution (env-first, then process.cwd()).
  const defaultCwd = process.env.BOT_CWD || process.cwd();

  // /code with no args: show current cwd with tier label
  if (!arg) {
    let current: string;
    if (resolvedWorkdir) {
      // Tier labels per §3.9: pinned, project, topic workspace, default
      const tierLabel: Record<string, string> = {
        override: 'pinned',
        project: 'project',
        'topic-home': 'topic workspace',
      };
      const label = tierLabel[resolvedWorkdir.tier];
      current = `${resolvedWorkdir.dir} (\`${label}\`)`;
    } else {
      // OLD format (pre-WP1): just the path, no tier labels
      current = state.cwd_override ?? defaultCwd;
    }
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

export interface SourcesCommandResult {
  matched: boolean;
  action: 'none' | 'show' | 'reset' | 'remove' | 'add';
  response: string;  // ready-to-send response for 'show', 'reset' and 'remove'
  path?: string;     // parsed (still-unresolved) path for 'add' — caller resolves + stats
  label?: string;    // optional label for 'add' (defaults to basename at addTopicSource time)
}

/**
 * Parse a /sources argument into a path and optional trailing label. Verbatim
 * copy of parseCodeArgs (quoted-path support), kept as a separate function so
 * /sources parsing does not couple to /code's path+instruction contract.
 */
export function parseSourceArgs(arg: string): { path: string; rest: string } {
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
 * Handle the /sources command — declare, list, or remove per-topic grounding
 * sources (grounding v2, 2026-09-06, internal design).
 *
 * /sources                  → show declared sources (or the empty-state hint)
 * /sources reset            → clear all declarations
 * /sources remove <n|path>  → remove one (1-based index or exact folded path)
 * /sources <path> [label]   → action:'add', returned UNAPPLIED — the caller
 *                             (main.ts) resolves + stats the path and applies
 *                             via addTopicSource, mirroring /code's split
 *                             (pure handler; stat validation left to the caller).
 */
export function handleSourcesCommand(state: ConversationState, userText: string): SourcesCommandResult {
  const match = SOURCES_PATTERN.exec(userText);
  if (!match) return { matched: false, action: 'none', response: '' };

  const arg = match[1]?.trim();

  // /sources with no args: list what this topic declares
  if (!arg) {
    if (!state.sources || state.sources.length === 0) {
      return {
        matched: true,
        action: 'show',
        response: '📚 No grounding sources declared for this topic. Add one with /sources <path>.',
      };
    }
    const rows = state.sources.map((s, i) => `${i + 1}. \`${s.path}\` — ${s.label?.trim() || s.path}`);
    return {
      matched: true,
      action: 'show',
      response: `📚 Grounding sources for this topic:\n${rows.join('\n')}\n\nRe-read fresh at every dispatch. Inline ≤${TOPIC_SOURCE_INLINE_MAX_CHARS} chars each; larger ones become must-read pointers. Manage: /sources remove <n|path>, /sources reset.`,
    };
  }

  // /sources reset: explicit removal path (declarations otherwise survive /new and /reset)
  if (arg.toLowerCase() === 'reset') {
    const had = state.sources?.length ?? 0;
    state.sources = [];
    return {
      matched: true,
      action: 'reset',
      response: had > 0
        ? `🗑 Cleared ${had} grounding source(s) for this topic.`
        : '📚 No grounding sources to clear.',
    };
  }

  // /sources remove <n|path>
  if (arg.toLowerCase() === 'remove' || arg.toLowerCase().startsWith('remove ')) {
    const token = parseSourceArgs(arg.slice(6).trim()).path;
    // Resolve the 1-based position with the same rules removeTopicSource
    // applies (numeric index, else exact case-sensitive folded path) so the
    // ok line can name the ordinal even for path-removals.
    const folded = token.trim().replace(/\\/g, '/');
    let pos = -1;
    if (/^\d+$/.test(token.trim())) {
      const i = parseInt(token.trim(), 10) - 1;
      if (i >= 0 && i < (state.sources?.length ?? 0)) pos = i;
    } else if (state.sources) {
      pos = state.sources.findIndex((s) => s.path.replace(/\\/g, '/') === folded);
    }
    const removed = removeTopicSource(state, token);
    if (!removed || pos === -1) {
      return {
        matched: true,
        action: 'remove',
        response: `⚠️ No source matches \`${token}\`. Use /sources to see the numbered list.`,
      };
    }
    const left = state.sources?.length ?? 0;
    return {
      matched: true,
      action: 'remove',
      response: `🗑 Removed source ${pos + 1}: \`${removed.path}\` — ${left > 0 ? `${left} left` : 'none left'}.`,
    };
  }

  // /sources <path> [label] — returned UNAPPLIED; caller validates + applies
  const { path, rest } = parseSourceArgs(arg);
  return {
    matched: true,
    action: 'add',
    response: '',
    path,
    label: rest ? rest.slice(0, 80) : undefined,
  };
}

/**
 * Handle the /update_brain command — deterministic interception + worker-executed staging.
 *
 * Returns:
 * - action: 'refusal' → skipWorker, send response locally
 * - action: 'stage' → rewrite userText to staging instruction, proceed to dispatch
 *
 * Pure function — no mkdir here (that's main.ts's job before calling this).
 */
export function isSingleSlashCommand(userText: string): string | undefined {
  const trimmed = userText.trim();
  if (!trimmed.startsWith('/')) return undefined;

  // Split on whitespace to check if it's a single token
  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 1) return undefined;

  // Strip @botname suffix if present
  const withoutBotname = tokens[0].replace(/@[\w]+$/, '');
  return withoutBotname || undefined;
}

/**
 * Check if a command string matches any known command pattern.
 * Returns true if the command is known, false otherwise.
 */
export function isKnownCommand(command: string): boolean {
  const testPatterns = [
    AGENT_SWITCH_PATTERN,
    AGENT_BARE_PATTERN,
    MODEL_SWITCH_PATTERN,
    DEFAULT_SWITCH_PATTERN,
    CODE_PATTERN,
    RESET_PATTERN,
    NEW_PATTERN,
    STATUS_PATTERN,
    SKILLS_PATTERN,
    AUTH_PATTERN,
    SECRET_PATTERN,
    HELP_PATTERN,
    HEALTH_PATTERN,
    REF_PATTERN,
    CLAIMS_PATTERN,
    REAUTH_PATTERN,
    RETRANSCRIBE_PATTERN,
    COMMIT_PATTERN,
    PUSH_PATTERN,
    PUSH_PUBLIC_PATTERN,
    INVESTIGATE_FLAGGED_PATTERN,
    UPDATE_BRAIN_PATTERN,
    // AI-203: /orchestrator is intercepted in processUpdate; known here so the
    // unknown-command guard (which runs earlier) does not eat it.
    ORCHESTRATOR_PATTERN,
    // AI-190: /debug is intercepted in processUpdate; known here so the
    // unknown-command guard (which runs earlier) does not eat it.
    DEBUG_PATTERN,
    // AI-201: /pair is intercepted in processUpdate; known here for the same
    // reason — the unknown-command guard runs before any handler.
    PAIR_PATTERN,
    // AI-110: /sources is intercepted in processUpdate; known here for the same
    // reason — the unknown-command guard runs before any handler.
    SOURCES_PATTERN,
    MODEL_TUNABLE_PATTERN,
    LLM_PATTERN,
    EFFORT_PATTERN,
    DEFAULT_TUNABLE_PATTERN,
    BRANCH_PATTERN,
    CHILD_OF_PATTERN,
    MERGE_PATTERN,
  ];

  // Also check pass-through patterns
  const testText = `/${command.replace(/^\//, '')}`; // Ensure it starts with / for the test
  if (PASS_THROUGH_PATTERN.test(testText)) return true;

  for (const pattern of testPatterns) {
    if (pattern.test(testText)) return true;
  }

  return false;
}

/**
 * Guard for unknown slash commands.
 * If the text is a single-token slash command that doesn't match any known command,
 * returns a response that should be sent locally and skipWorker=true.
 * Otherwise returns undefined (proceed to normal dispatch).
 */
export function guardUnknownCommand(userText: string): { response: string; skipWorker: true } | undefined {
  const singleCommand = isSingleSlashCommand(userText);
  if (!singleCommand) return undefined;

  if (isKnownCommand(singleCommand)) return undefined;

  return {
    response: `Unknown command: ${singleCommand}\n\nTry /help for available commands.`,
    skipWorker: true,
  };
}

/** Age label for a thread's updatedAt: `<m>m` under an hour, else `<h>h`.
 *  Unparseable/negative ⇒ '0m'. */
function threadAgeLabel(updatedAt: string): string {
  const ms = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const min = Math.floor(ms / 60000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`;
}

/**
 * AI-203: /orchestrator — per-topic orchestrator-mode command (pure state
 * mutation + frozen §4.7 reply texts). `on` arms the mode; `off` disarms it;
 * bare/`status` renders the thread list without touching the flag. The caller
 * (main.ts) performs the actual session clear when clearSession is true.
 */

export function handleOrchestratorCommand(
  userText: string,
  topicState: ConversationState,
  threads: ThreadRecord[]
): { response: string; clearSession: boolean } {
  const match = ORCHESTRATOR_PATTERN.exec(userText);
  if (!match) return { response: '', clearSession: false };
  const arg = (match[1] ?? '').toLowerCase();
  if (arg === 'on') {
    topicState.orchestrator_enabled = true;
    return {
      response: '🧭 Orchestrator mode ON. This conversation now routes work instead of executing it; execution happens in spawned threads. Conversation context reset.',
      clearSession: true,
    };
  }
  if (arg === 'off') {
    // AI-215 (2026-09-14): default-on means the opt-out must persist a REAL
    // stored `false`, not a deleted key — `isOrchestratorMode` now reads
    // `!== false`, so a deleted key would read ON. The session clear (role
    // boundary) still happens via clearSession in the caller.
    topicState.orchestrator_enabled = false;
    return {
      response: '🧭 Orchestrator mode OFF. Back to normal execution in this topic. Conversation context reset.',
      clearSession: true,
    };
  }
  const lines = threads.map((t) =>
    `- ${t.id} — ${t.title} (${t.status}) · updated ${threadAgeLabel(t.updatedAt)}` +
    (t.pendingInput.length > 0 ? ` · +${t.pendingInput.length} queued` : '') +
    (t.status === 'queued' && t.dependsOn && t.dependsOn.length > 0 ? ` · waiting on ${t.dependsOn.join(', ')}` : '')
  );
  // AI-215 (2026-09-14): default-on — ON unless an explicit `false` opt-out.
  const mode = topicState.orchestrator_enabled !== false ? 'ON' : 'OFF';
  return {
    response: `🧭 Orchestrator mode: ${mode}.\n${lines.length > 0 ? lines.join('\n') : 'No threads.'}`,
    clearSession: false,
  };
}

export function handleUpdateBrainCommand(
  state: ConversationState,
  userText: string,
  exemptions: ReadonlyMap<string, string>
): UpdateBrainResult {
  const match = UPDATE_BRAIN_PATTERN.exec(userText);
  if (!match) {
    // Should not happen if pattern matched, but handle gracefully
    return { action: 'refusal', response: 'Invalid /update_brain command.' };
  }

  const guidanceText = match[1]?.trim() || '';

  // Refusal 1: thread 0 (general + DM collision, F5)
  if (state.thread_id === 0) {
    return {
      action: 'refusal',
      response: "🚫 General/DM topics don't get topic brains — the archive can't separate thread 0 across chats. Nothing staged.",
    };
  }

  // Refusal 2: hard-exempt classes
  const topicKey = `${state.chat_id}_${state.thread_id}`;
  const exemptClass = exemptions.get(topicKey);
  if (exemptClass && ['output-only', 'duplicate', 'one-off', 'pinned-guide'].includes(exemptClass)) {
    return {
      action: 'refusal',
      response: `🚫 This topic is exempt from topic brains (${exemptClass}). Nothing staged.`,
    };
  }

  // Build staging instruction
  const PA_HOME = process.env.PA_HOME ?? os.homedir() + '/.pa';
  const stagedPath = `${PA_HOME}/topic-brains/.staged/${topicKey}.md`;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const hours = String(now.getUTCHours() + 5).padStart(2, '0').slice(-2); // IST is UTC+5:30
  const minutes = String(now.getUTCMinutes() + 30).padStart(2, '0').slice(-2);
  const timeStr = `${hours}:${minutes}`;

  // Check if brain exists (async, but main.ts will need brainPath anyway for the check)
  // For now, build the instruction template
  let instruction = `The user ran /update_brain in this topic. Capture this topic's durable learnings: extract the facts, decisions, conventions, and open threads from this conversation that belong in the topic's long-term memory. APPEND them as one new markdown section titled "## Staged ${dateStr} (${timeStr} IST)" to the file ${stagedPath} — create the file if it does not exist; plain bullets; recency wins over older statements. If the topic brain at <BRAIN_PATH_ABS> already records a fact, stage only what is new or changed. Do NOT edit BRAIN.md, INDEX.md, or anything else under the topic-brains directory — the nightly consolidation pass folds staged sections into the brain. Finish with a one-line confirmation of what you staged.`;

  // Append guidance if provided
  if (guidanceText) {
    instruction += `\nUser guidance: ${guidanceText}`;
  }

  return {
    action: 'stage',
    instruction,
    stagedPath,
    response: guidanceText
      ? `Capture this topic's learnings for its topic brain — with your note: ${guidanceText}`
      : `Capture this topic's learnings for its topic brain`,
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
  // Same reason_code-plumbing pattern as expirePreferredWorker: main.ts's RESET_PATTERN
  // branch calls refreshPinnedStatusCardInPlace right after this, which re-hydrates and
  // recomputes current_worker/default_worker from live config — the '' placeholders here
  // only need to be falsy so that recompute's priority chain falls through correctly.
  // pinned_worker is cleared too — see expirePreferredWorker's comment for why a stale
  // mirror left from a prior override would otherwise outrank the real default.
  state.pinned_worker = undefined;
  state.model_status = buildModelStatusSnapshot({
    currentWorker: '',
    defaultWorker: '',
    reasonCode: 'reset',
  });
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

/**
 * Handle the /health command. Returns a marker indicating the command was matched.
 * The actual health check is executed in main.ts via spawning pa health.
 */
export function handleHealthCommand(): { matched: boolean } {
  return { matched: true };
}

/**
 * Handle the /ref <id> command. Extracts the ref ID.
 * The actual lookup is executed in main.ts via spawning pa ref <id>.
 */
export function handleRefCommand(userText: string): { matched: boolean; refId?: string } {
  const match = REF_PATTERN.exec(userText);
  if (!match) return { matched: false };
  return { matched: true, refId: match[1] };
}

/**
 * Handle the /claims command. Returns a marker indicating the command was matched.
 * The actual claims lookup is executed in main.ts via spawning pa claims.
 */
export function handleClaimsCommand(): { matched: boolean } {
  return { matched: true };
}

/**
 * Handle the /reauth [skill] command. Extracts the optional resume-skill name.
 * The actual link request is executed in main.ts via spawning
 * pa/scripts/start_google_telegram_reauth.py.
 */
export function handleReauthCommand(userText: string): { matched: boolean; skill?: string } {
  const m = REAUTH_PATTERN.exec(userText);
  if (!m) return { matched: false };
  return { matched: true, skill: m[1] };
}

// parseReauthCallback lives in pa/src/lib/callback-grammar.ts since 2026-09-02 and is
// re-exported above (see the REAUTH_PATTERN block).

export function isPassThroughCommand(userText: string): boolean {
  return PASS_THROUGH_PATTERN.test(userText);
}

export interface RetranscribeCommandResult {
  matched: boolean;
  /** Optional engine override, e.g. `/retranscribe groq` — threads to
   * voice.ts's `engineOverride` (WP4). Undefined = 'auto'. */
  engine?: string;
}

/** Parses `/retranscribe [engine]`. Pure — no I/O, no access to the replied
 * message (WP6 does that: finds the media being replied to, calls
 * findCachedAudio/transcribeVoiceMessage with this parsed engine override,
 * and dispatches the result through the normal chain). */
export function handleRetranscribeCommand(userText: string): RetranscribeCommandResult {
  const match = RETRANSCRIBE_PATTERN.exec(userText);
  if (!match) return { matched: false };
  const engine = match[1]?.trim();
  return { matched: true, engine: engine || undefined };
}

/** Duck-typed subset of a forwarded message's origin fields. Deliberately
 * NOT imported from types.ts — forward_origin/forward_from/forward_sender_name
 * land there in WP6; a real TelegramMessage satisfies this structurally once
 * those fields exist. Covers both the modern `forward_origin` shape (Bot API
 * 7.0+) and the legacy flat fields older clients/updates still send. */
export interface ForwardableMessageLike {
  forward_origin?: {
    type: 'user' | 'hidden_user' | 'chat' | 'channel' | string;
    sender_user?: { first_name?: string; username?: string };
    sender_user_name?: string;
    sender_chat?: { title?: string };
    chat?: { title?: string };
  };
  forward_from?: { first_name?: string; username?: string };
  forward_sender_name?: string;
}

/** Feeds voice.ts's `formatTranscriptUserText({ forwardedFrom })` (WP4).
 * Scope: only wired for voice/audio/video_note forwards in this pass —
 * forwarded-*text* attribution is deliberately deferred (widest blast radius
 * of any single-line change in this wave; see the plan's "out of scope"). */
export function describeForwardOrigin(msg: ForwardableMessageLike): string | undefined {
  const origin = msg.forward_origin;
  if (origin) {
    switch (origin.type) {
      case 'user':
        return origin.sender_user?.first_name || origin.sender_user?.username || undefined;
      case 'hidden_user':
        return origin.sender_user_name || 'a hidden user';
      case 'chat':
        return origin.sender_chat?.title ? `the chat "${origin.sender_chat.title}"` : undefined;
      case 'channel':
        return origin.chat?.title ? `the chat "${origin.chat.title}"` : undefined;
      default:
        return undefined;
    }
  }

  // Legacy fields (pre-forward_origin Bot API updates).
  if (msg.forward_from) {
    return msg.forward_from.first_name || msg.forward_from.username || undefined;
  }
  if (msg.forward_sender_name) {
    return msg.forward_sender_name;
  }

  return undefined;
}

/**
 * Handle the /branch command. Validates the branch name and extracts optional creation prompt.
 * Pure — no state mutation, no I/O. Topic creation is done in main.ts.
 */
export function handleBranchCommand(
  _state: ConversationState,
  userText: string
): { matched: boolean; branchName?: string; prompt?: string; response: string } {
  const match = BRANCH_PATTERN.exec(userText);
  if (!match) return { matched: false, response: '' };

  const full = match[1].trim();
  const spaceIdx = full.search(/\s/);
  const branchName = spaceIdx === -1 ? full : full.slice(0, spaceIdx);
  const prompt = spaceIdx === -1 ? undefined : full.slice(spaceIdx).trim() || undefined;

  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(branchName)) {
    return {
      matched: true,
      response: 'Branch name must be 1–50 alphanumeric, dash, or underscore characters.',
    };
  }

  return { matched: true, branchName, prompt, response: '' };
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


export function isKnownAgentName(name: string): boolean {
  return /^(claude|zclaude|codex|agyc|agy)$/i.test(name.trim());
}

export interface AgentSwitchResult {
  target: string;
  isLegacy?: boolean;
}

export function getAgentSwitchTarget(userText: string): AgentSwitchResult | undefined {
  const text = userText.trim();
  // Primary: /agent <name> or /agents <name>
  const agentMatch = /^\/agents?(?:@\w+)?\s+(claude|zclaude|codex|agyc|agy)\b/i.exec(text);
  if (agentMatch?.[1]) {
    return { target: agentMatch[1].toLowerCase(), isLegacy: false };
  }
  // Legacy: /model <name> or /models <name> where <name> is a known agent name
  const modelMatch = /^\/models?(?:@\w+)?\s+(claude|zclaude|codex|agyc|agy)\b/i.exec(text);
  if (modelMatch?.[1]) {
    return { target: modelMatch[1].toLowerCase(), isLegacy: true };
  }
  return undefined;
}

export function getModelSwitchTarget(userText: string): string | undefined {
  return getAgentSwitchTarget(userText)?.target;
}

export function handleModelSwitch(
  state: ConversationState,
  userText: string
): { switched: boolean; response: string } {
  const res = getAgentSwitchTarget(userText);
  if (!res) return { switched: false, response: '' };
  state.preferred_worker = res.target;
  state.preferred_worker_set_at = new Date().toISOString();
  state.session = undefined;
  if (res.isLegacy) {
    return {
      switched: true,
      response: `Switched agent to *${res.target}* (until midnight IST).\n💡 _Tip: use /agent <name> to pick the agent and /model <name> to set its model._`,
    };
  }
  return { switched: true, response: `Switched agent to *${res.target}* (until midnight IST).` };
}

/**
 * Expire a /agent or /model override if it was set on a previous IST calendar day.
 * Returns true if the override was cleared, false if no change.
 *
 * Sets model_status.reason_code to 'midnight_reset' so the next status-card refresh
 * reports the real cause instead of falling back through hydrateModelStatus's generic
 * inferLegacyReasonCode() (which would call this ambient 'default_active'). current_worker
 * and default_worker are placeholders ('') deliberately — hydrateModelStatus/refresh
 * always recomputes both from live state + config on the very next hydrate, so a wrong
 * guess here (main.ts has no reachable point where THIS function knows the effective
 * default worker) can never survive to the saved snapshot; the placeholder only needs to
 * be falsy so the current_worker priority chain falls through to the real default.
 * pinned_worker is cleared alongside model_status for the same reason: hydrateModelStatus's
 * candidateWorker chain also falls back to state.pinned_worker, and a stale mirror left
 * from a PRIOR override would otherwise outrank the real default the same way a stale
 * model_status.current_worker would (see the /agent-switch-to-default finding,
 * plans/2026-09-01-revived-bot-tests-bitrot-findings.md family notes) — this only guards
 * this function's own callers, not the deeper hydrateModelStatus resolution-order gap.
 */
export function expirePreferredWorker(state: ConversationState): boolean {
  if (!state.preferred_worker || !state.preferred_worker_set_at) return false;

  const setAtIST = toIST(new Date(state.preferred_worker_set_at)).toISOString().slice(0, 10);
  const today = todayIST();

  if (setAtIST !== today) {
    state.preferred_worker = undefined;
    state.preferred_worker_set_at = undefined;
    state.session = undefined;
    state.pinned_worker = undefined;
    state.model_status = buildModelStatusSnapshot({
      currentWorker: '',
      defaultWorker: '',
      reasonCode: 'midnight_reset',
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Worker tunables — /model, /llm, /effort, and the /default <setting> extension
//
// ONE bot-level command per knob, whichever CLI is active. The bot word maps to
// a config SETTING NAME (`/model` or `/llm` -> `model`), and the worker's own `tunables:`
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
 * `/model` sets the model tunable.
 * `/effort` sets the reasoning effort tunable.
 */
export const TUNABLE_COMMAND_SETTINGS: Record<string, string> = {
  model: 'model',
  effort: 'effort',
};

/**
 * Explains that /llm (and /default llm) has been sunset in favor of /model and /agent.
 */
export function handleSunsetLlmCommand(userText: string): { matched: boolean; response: string } {
  const text = userText.trim();
  if (LLM_PATTERN.test(text)) {
    return {
      matched: true,
      response:
        'ℹ️ */llm has been sunset in favor of /model.*\n\n' +
        '• Use `/model <name>` (or bare `/model`) to set or view the foundation model for this topic.\n' +
        '• Use `/agent <name>` (or bare `/agent`) to switch or view the active agent harness (`agy`, `agyc`, `claude`, `codex`, `zclaude`).',
    };
  }
  const defMatch = DEFAULT_TUNABLE_PATTERN.exec(text);
  if (defMatch && defMatch[1].toLowerCase() === 'llm') {
    return {
      matched: true,
      response:
        'ℹ️ */default llm has been sunset in favor of /default model.*\n\n' +
        '• Use `/default model <name>` to set the topic default foundation model.\n' +
        '• Use `/default <agent>` or `/default agent <name>` to set the topic default agent.',
    };
  }
  return { matched: false, response: '' };
}

/** Words that mean "unset this tier and fall through to the next one". */
export const TUNABLE_CLEAR_TOKENS = new Set(['clear', 'reset', 'default', 'unset', '-']);

export type TunableScope = 'session' | 'topic';
export type TunableAction = 'show' | 'set' | 'clear';

export interface TunableCommand {
  scope: TunableScope;   // session = /model|/effort (expires at IST midnight); topic = /default (persistent)
  setting: string;       // normalized CONFIG setting name, e.g. 'model'
  label: string;         // the word the user typed, echoed back in help text ('model', 'effort', …)
  action: TunableAction;
  value?: string;        // present for action === 'set'
}

/**
 * Parse /model, /effort and `/default <setting> [value]` into one shape.
 *
 * Deliberately order-independent: `/default <agent>` and `/agent <name>` are excluded here (not just
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

  // If this text is an agent switch (/agent <name> or legacy /model <name>), do not hijack
  if (getAgentSwitchTarget(text)) return undefined;
  if (AGENT_BARE_PATTERN.test(text)) return undefined;

  const model = MODEL_TUNABLE_PATTERN.exec(text);
  if (model) return build('session', 'model', TUNABLE_COMMAND_SETTINGS['model']!, model[1]);

  const effort = EFFORT_PATTERN.exec(text);
  if (effort) return build('session', 'effort', TUNABLE_COMMAND_SETTINGS['effort']!, effort[1]);

  if (DEFAULT_SWITCH_PATTERN.test(text)) return undefined;   // `/default agy` or `/default agent agy` — the agent form owns this
  const def = DEFAULT_TUNABLE_PATTERN.exec(text);
  if (def) {
    const label = def[1].toLowerCase();
    if (label === 'llm') return undefined; // sunset in favor of /default model
    if (isKnownAgentName(label)) return undefined;
    if (label === 'agent') {
      const rest = def[2]?.trim();
      if (rest && isKnownAgentName(rest)) return undefined;
    }
    const setting = TUNABLE_COMMAND_SETTINGS[label] ?? normalizeTunableName(label);
    if (!setting) return undefined;
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

/**
 * Promote active session configuration (preferred_worker and session tunable overrides)
 * to persistent topic-tier defaults.
 */
export function promoteSessionToTopicDefaults(state: ConversationState, currentWorker: string): void {
  state.preferred_worker = undefined;
  state.preferred_worker_set_at = undefined;

  const overrides = state.tunable_overrides?.[currentWorker];
  if (overrides) {
    for (const [setting, value] of Object.entries(overrides)) {
      if (value) {
        setTopicTunable(state, currentWorker, setting, value);
        setSessionTunable(state, currentWorker, setting, undefined);
      }
    }
  }
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
  previousDescriptor?: string;
  currentDescriptor?: string;
}

export function renderTunableSetResult(input: TunableSetResultInput): string {
  const lifetime = input.scope === 'session'
    ? 'until midnight IST'
    : 'topic default — persists';
  const header = input.previousDescriptor && input.currentDescriptor
    ? `Switched ${input.setting}: ${input.previousDescriptor} → ${input.currentDescriptor} (${lifetime}).`
    : `${input.setting} → *${input.value}* on ${input.worker} (${lifetime}).`;
  const lines = [header];
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
  previousDescriptor?: string;
  currentDescriptor?: string;
}

export function renderTunableClearResult(input: TunableClearResultInput): string {
  const scopeLabel = input.scope === 'session' ? 'session override' : 'topic default';
  const tier = input.resolved?.tier ?? 'cli';
  const pinned = (input.pinned ?? []).filter(Boolean);
  // Same honesty rule as the report: falling back to "nothing" still means
  // `--model opusplan` on a worker that pins one in config.yaml.
  const now = tier === 'cli' && pinned.length > 0
    ? `${pinned[0]} (this worker's fixed args in config.yaml)`
    : `${formatTunableValue(input.resolved)} (${TUNABLE_TIER_LABELS[tier]})`;
  if (input.previousDescriptor && input.currentDescriptor) {
    return `Cleared ${scopeLabel} for ${input.setting}: ${input.previousDescriptor} → ${input.currentDescriptor}.\nNow: ${now}.`;
  }
  return `Cleared ${scopeLabel} for ${input.setting} on ${input.worker}.\nNow: ${now}.`;
}

/**
 * Render notification when session overrides are cleared manually via /reset or expired at midnight IST.
 */
export function renderSessionExpiryMessage(
  previousDescriptor: string,
  currentDescriptor: string,
  reason: 'cleared' | 'expired' = 'cleared'
): string {
  const action = reason === 'expired' ? 'expired' : 'cleared';
  return `🔄 Session overrides ${action}: ${previousDescriptor} → ${currentDescriptor}.`;
}

/**
 * WPE2: Risk-flag surfacing helper for self-improver HITL alerts.
 * Checks if an audit record carries risk flags that require operator approval
 * and returns the appropriate InlineKeyboardMarkup for HITL buttons.
 *
 * Moved to pa/src/lib/hitl-keyboard.ts (2026-08-24 buttons program, P5) so pa's
 * self-improver can attach the same keyboard without importing bot code — this is a
 * re-export, not a reimplementation; output must stay byte-identical (verified by this
 * file's own hitl-buttons.test.ts and pa/tests/hitl-keyboard.test.ts).
 *
 * @param auditRecord - The audit record to check (from self-improver-audit.jsonl)
 * @returns InlineKeyboardMarkup if risk flags present, undefined otherwise
 */
export { buildHITLKeyboard } from '../../../pa/dist/src/lib/hitl-keyboard.js';

// Reply pipeline (AI-173 phase 6, 2026-09-14): the pending-action/confirmation/
// question state machine (C5), PA_META parse/apply + premature-async guard (C6),
// and the markdown/worker-reply formatting pipeline (C7) moved to worker-reply.ts.
// PA_META_PROTECTED_SKILLS moved WITH C6 to kill the C6→C1 cycle; WorkerResult moved
// WITH C7. Re-exported here so all existing importers of ../logic.js stay byte-untouched
// (permanent barrel — logic.ts is not a composition root; importers never churn).
export {
  CONFIRMATION_YES,
  CONFIRMATION_NO,
  CONFIRMATION_PATTERN,
  PENDING_ACTION_TTL_MS,
  expirePendingAction,
  resolveConfirmation,
  consumeConfirmation,
  expirePendingQuestion,
  resolveQuestionAnswer,
  resolvePendingDescription,
  isPrematureAsyncReply,
  repairLoneBackslashes,
  parseMetadata,
  sanitizeSpawnDependsOn,
  SUGGESTED_ITEM_MAX,
  SUGGESTED_ITEM_LABEL_MAX,
  sanitizeSuggestedItems,
  applyMetaActions,
  PA_META_DOWNSTREAM_TYPES,
  PA_META_PROTECTED_SKILLS,
  normalizeMarkdown,
  formatWorkerReply,
  buildWorkerResponse,
  buildWorkerErrorResponse,
} from './worker-reply.js';
export type { WorkerResult } from './worker-reply.js';
