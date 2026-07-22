import type { RateLimitClassification, RateLimitSource } from './rate-limits.js';

export type FailoverKind = 'rate-limit' | 'unavailable' | 'failure' | 'proactive-warning';

export interface FailoverNotifyPayload {
  from: string;
  to: string | null;
  kind: FailoverKind;
  reasonText: string;
  minutes?: number;
  classification?: RateLimitClassification;
  source?: RateLimitSource;
  resetsAtIST?: string;
  usedPercent?: number;
  raw?: string;   // unfiltered error text for cases where parsing was partial
}

/**
 * Declared values for one tunable — a HINT LIST FOR DISPLAY, NEVER A GATE.
 *
 *  - string[]                : the canonical words pass through to the CLI unchanged.
 *  - Record<canon, native>   : canonical-to-native map, for a CLI whose vocabulary
 *                              differs (e.g. high -> "3"), so one bot-level word
 *                              keeps one meaning across every worker.
 *
 * A value OUTSIDE this list is still accepted and passed through; the bot may
 * merely note "not a known value for <worker>". See TunableSpec.
 */
export type TunableValues = string[] | Record<string, string>;

/**
 * One user-settable knob a worker's CLI exposes (e.g. model, reasoning effort),
 * declared per worker under `tunables:` in config.yaml.
 *
 * DECLARING A FLAG A CLI DOES NOT HAVE BREAKS EVERY DISPATCH TO THAT WORKER —
 * an invalid flag is rejected by the CLI itself, so it looks like a worker
 * outage, not a settings error (this exact bug shipped in the agy scaffold with
 * --yolo/--output-format and went unnoticed). Declare only flags verified
 * against that CLI's own --help. Under-declaring is safe; over-declaring is not.
 *
 * Contract: STRICT ON THE KNOB, FREE ON THE VALUE. The setting NAME and its arg
 * template are validated against this declaration at command time; the VALUE
 * never is. Model names move fast (agy self-updated from "Gemini 3.5 Flash" to
 * "Gemini 3.6 Flash" within one afternoon), so any allowlist of values would
 * ship stale. A bad value fails visibly at the CLI with the CLI's own error.
 *
 * `args` IS AN ARG TEMPLATE, NOT flag+value. A flag/value pair cannot express
 * codex, which has no --effort flag and spells the same concept as a config
 * override: ["-c", "model_reasoning_effort={value}"]. Every occurrence of the
 * literal "{value}" in any element is replaced with the (native-mapped) value;
 * at least one element must contain it, or the user's value would be silently
 * dropped.
 */
export interface TunableSpec {
  args: string[];          // arg template appended when the setting is SET, e.g. ["--model", "{value}"]
  default?: string;        // worker-level default (cascade tier 3); omit to fall through to the CLI's own default
  description?: string;    // human-readable help text (bot + dashboard print it)
  values?: TunableValues;  // declared values — display hint only, never validated against
  /**
   * Settings this one SUPERSEDES: when this setting resolves to a value, each
   * named setting contributes NO ARGS for that dispatch, even though it is set.
   *
   * Knobs are independent for most CLIs, but not all — and where they are not,
   * emitting both is the worst possible failure: the CLI rejects the command
   * line, so EVERY dispatch in that topic dies and reads as a worker outage
   * rather than a settings mistake. Which pairs conflict is CLI knowledge, and
   * CLI knowledge belongs in config (hardcoding worker names in TypeScript is
   * exactly what rotted before), so the conflict is declared here rather than
   * detected in code. Motivating case (agy v1.1.5, verified live 2026-07-22):
   * its reasoning effort is EMBEDDED in the model name
   * (gemini-3.6-flash-high), and its Claude-family models reject --effort
   * outright — so `model: {supersedes: [effort]}`.
   *
   * Deliberately tier-INDEPENDENT: a model set at ANY tier supersedes an effort
   * set at any other. The rule states that the two cannot go on the command line
   * together at all, which is not a question of who set what more recently.
   *
   * The superseded setting keeps its stored value and is still reported to the
   * user (flagged as superseded) — suppression applies to the ARGS only, so
   * clearing the winner brings it straight back.
   */
  supersedes?: string[];
}

export interface WorkerConfig {
  name: string;
  command: string;
  args: string[];
  check: string;
  rate_limit_patterns: string[];
  priority: number;
  state_dir?: string;      // where this CLI writes conversation state
  state_pattern?: string;  // glob pattern for state files (e.g. "*.jsonl")
  input_mode?: 'arg' | 'stdin-json' | 'stdin-text';  // how to pass prompt: CLI arg (default), stdin stream-json, or stdin plain text
  output_format?: string;  // e.g. "stream-json" for NDJSON output
  check_timeout?: number;  // seconds to wait for version check (default 30)
  tunables?: Record<string, TunableSpec>;  // per-worker settable knobs (see TunableSpec); absent = worker has none, behaves exactly as before
}

export interface EvaluatorConfig {
  worker: string;    // which CLI evaluates (default: "claude")
  timeout: number;   // max seconds for evaluator (default: 60)
}

export interface BgTasksConfig {
  alert_seconds: number;
  alert_repeat_seconds: number;
}

export interface PaConfig {
  workers: WorkerConfig[];
  evaluator?: EvaluatorConfig;
  topic_defaults?: Record<string, string>;  // topicKey ("chatId_threadId") → worker name
  bg_tasks: BgTasksConfig;
  concurrency_limit?: number; // max parallel skills in catchup
}

export const DEFAULT_TIMEOUT = 3600;       // max total seconds
export const DEFAULT_IDLE_TIMEOUT = 300;   // max seconds of silence before kill

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  idleTimeout?: number;
  extraArgs?: string[];
  resource?: string;   // unique identifier for the task (e.g. topicId, skillName)
  agentName?: string;  // name of the agent (e.g. gemini, claude)
  isEvaluator?: boolean; // prevents recursive LLM evaluation of the evaluator itself
  onWorkerSwitch?: (payload: FailoverNotifyPayload) => Promise<void>;
  checkAvailable?: (worker: WorkerConfig) => Promise<boolean>;
  preferredWorker?: string;  // preferred worker name (e.g. "codex") to try first
  excludeWorkers?: Set<string>; // workers to skip (already failed in earlier dispatch phases)
  updateId?: number; // Telegram update_id for log correlation
  suppressExitAlert?: boolean; // suppress worker-exit notify for intermediate failover attempts
  noFallback?: boolean; // when true, stop on first failure instead of continuing to next worker
  priorAttempts?: string[]; // workers that already failed before runWithFailover was invoked
  contextId?: string; // execution-context UUID; allows nested same-context blackboard lock re-entrancy
  bgTasksConfig?: BgTasksConfig; // BG-task alert thresholds; defaults to 300s/1800s if absent
  _bgTaskHooks?: { // injectable for tests
    getDescendantPids?: (pid: number) => Promise<Array<{ pid: number; parentPid: number }>>;
    getCommandLines?: (pids: number[]) => Promise<Map<number, string>>;
    areProcessesAlive?: (pids: number[]) => Promise<Map<number, boolean>>;
    notifyUser?: (subject: string, body: string, opts?: { dedupKey?: string }) => Promise<{ sent: boolean; suppressed: boolean }>;
    heartbeatIntervalMs?: number;
  };
}

export interface TelegramOutput {
  chat_id: string;   // always string — YAML may parse large integers, so loadSkill coerces with String()
  thread_id?: number; // optional forum topic thread ID
  token_secret: string; // name of the secret holding the bot token (e.g. "TELEGRAM_BOT_TOKEN")
}

export interface SkillFrontmatter {
  cron?: string;
  on_missed?: 'latest' | 'all' | 'skip';
  cwd?: string;
  secrets?: string[];
  timeout?: number;       // max total seconds (default DEFAULT_TIMEOUT)
  idle_timeout?: number;  // max seconds of silence before kill (default DEFAULT_IDLE_TIMEOUT)
  trigger_description?: string;  // LLM-readable description of when to fire this skill from a brief
  inject_triggers?: boolean;     // if true, inject all other skills' trigger_descriptions into this skill's prompt
  worker?: string;               // preferred worker for this skill (e.g. "claude", "gemini", "zclaude")
  no_fallback?: boolean;         // when true, don't failover to other workers on failure
  cmd?: string;                  // direct shell command to execute (bypasses LLM if set)
  topic?: string;                // optional custom topic name for partitioning (replaces queue/priority)
  telegram_output?: TelegramOutput; // if set, pa run delivers LLM output to this Telegram chat/thread
  critical?: boolean;            // if true, self-improver never autonomously approves changes targeting this skill
  worker_args?: string[];        // extra CLI args appended to the worker command for THIS skill only (e.g. gemini --include-directories to widen its file-tool workspace beyond the shim-forced repo cwd). Merged ahead of run-time extraArgs.
}

export interface Skill {
  name: string;
  path: string;
  frontmatter: SkillFrontmatter;
  prompt: string;
}

export interface DraftMeta {
  proposed_at: string;
  reason: string;
  source_turns: string[];
  // 'rejected_stale' (2026-07-11): pending >14 days, reaped by the staleness sweep.
  // 'rejected_auto' (2026-07-11): cmd-based fix target — prompt fixes are no-ops for it,
  // auto-rejected immediately rather than left pending.
  status: 'pending' | 'approved' | 'rejected' | 'rejected_post_rollback' | 'rejected_stale' | 'rejected_auto';
  fingerprint: string;
  source_type: 'conversation' | 'failure' | 'feedback';
  reviewed_at?: string;
  target_skill?: string;          // for fix/reinforce drafts: which existing skill this targets
  approved_autonomously?: boolean; // true if self-improver approved/applied this without human review
  applied_in_place?: boolean;      // true if this was applied via applyFix() (overwrote target_skill's skill.md) rather than approveDraft() (deployed as its own new skill)
  risk_flags?: string[];          // 'critical-skill' | 'declares-secrets' — recorded at gate time (2026-07-11), no longer blocks
}

export interface DraftProposal {
  name: string;
  reason: string;
  source_message_ids: string[];
  frontmatter: Partial<SkillFrontmatter>;
  prompt: string;
  target_skill?: string; // set by failure-analyzer.ts/feedback-analyzer.ts for fix/reinforce proposals — the existing skill this proposal targets. Proposal-authoring metadata, NOT part of SkillFrontmatter (never written into a deployed skill.md).
  code_target?: string;  // set by failure-analyzer.ts (2026-07-11) when its evidence names a specific source file likely causing the failure — a relative repo path (e.g. "projects/daily-mail-brief/scripts/run_brief.py"), validated in analyzer.ts's parseProposalResponse. A hint for code-fixer.ts's attemptCodeFix(), not authoritative on its own — the coding worker still explores the project itself.
}

export interface RunMeta {
  worker: string;
  status: 'success' | 'error' | 'rate_limited';
  exitCode: number | null;
  duration: number;
  timestamp: string;
  error?: string;
  extraArgs?: string[];
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number | null;
  sessionId?: string; // CLI session ID (Claude: from NDJSON stream; Gemini: undefined, discovered from disk)
  evaluatorSummary?: string; // user-facing summary from LLM evaluator (set on both kill and done verdicts)
  alreadyAlertedPaSupport?: boolean; // true when runWithFailover already emitted exhaustion/wall alert
  rateLimitTelemetry?: {
    usedPercent: number;
    windowMinutes: number;
    resetsAt: number; // unix seconds
  };
}
