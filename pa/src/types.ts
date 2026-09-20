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
  /**
   * Optional allowlist of secret names this LLM worker receives.
   *
   * SEMANTICS (backward compatible):
   * - Field ABSENT: worker receives ALL secrets (current behavior).
   * - Field PRESENT: worker receives ONLY the named secrets.
   *
   * LLM workers (agy, claude, codex, zclaude): this field controls which secrets
   * from secrets.env are injected into the worker's environment.
   *
   * Shell skills (cmd: skills): these keep their existing frontmatter `secrets:`
   * filtering, which already default-denies — this field does not affect them.
   *
   * Secret names must match the pattern [A-Z0-9_]+ (uppercase alphanumeric + underscore).
   * Unknown names (not present in secrets.env) warn but don't block dispatch —
   * the worker receives the subset that exists.
   *
   * MOTIVATION: Defense-in-depth. A worker compromised (exploit, leaked token in logs,
   * or supply-chain backdoor) can only access secrets it was explicitly granted.
   */
  secret_allowlist?: string[];

  /**
   * When true, this worker is EXCLUDED from automatic failover ordering —
   * runWithFailover skips it unless the dispatch EXPLICITLY names it
   * (options.preferredWorker or config.worker_pin). For workers that are
   * manually selectable (bot /agent, skill `worker:` frontmatter) but should
   * never receive another worker's spilled-over traffic. (Added 2026-08-21
   * for agyc: it had silently swallowed failover runs while its stream
   * dialect was unparsed — the worker itself is fine for manual use, but the
   * operator wants it out of every automatic chain.)
   */
  manual_only?: boolean;
}

export interface EvaluatorConfig {
  worker: string;    // which CLI evaluates (default: "claude")
  timeout: number;   // max seconds for evaluator (default: 60)
}

export interface BgTasksConfig {
  alert_seconds: number;
  alert_repeat_seconds: number;
}

/** Operator override for one declared maintenance job (see
 *  pa/src/lib/maintenance/types.ts). May only DISABLE a job or CHANGE its
 *  cadence — never add or widen a target, flip `destructive`, or clear
 *  `shedWhenDegraded: false`. */
export interface MaintenanceConfig { enabled?: boolean; everyMs?: number; }

/**
 * Deployment policy for the Telegram voice-transcription feature (see
 * plans/2026-08-04-telegram-voice-transcription.md, D1/D2). Lives in
 * config.yaml, not secrets.env: these are choices an operator makes once —
 * which engine family, which cloud provider order, which local execution
 * mode — not operational tuning like timeouts, which are PA_VOICE_* env
 * vars (D1's hard split: a knob with two homes is a knob nobody can predict
 * the effective value of).
 */
export type TranscriptionEnginePreference = 'auto' | 'cloud' | 'local';
export type TranscriptionWorkerMode = 'spawn' | 'persistent';

/**
 * `worker_mode` applies to the LOCAL engine only — cloud calls have no model
 * to load, so there is nothing for a persistent process to amortise.
 *
 * Mode switching is a static config edit. No code may choose a mode
 * per-message based on load, frequency, or recent latency: that would
 * introduce nondeterminism into a path whose failure modes are already hard
 * to reproduce, and runs against this repo's move toward declared,
 * observable configuration over hidden-timer/heuristic behaviour (AI-100).
 *
 * `cloud_order` is a config field rather than a hard-coded constant because
 * which cloud ASR provider to prefer is deployment knowledge, and this
 * repo's standing discipline is that CLI/provider knowledge lives in
 * config, not in TypeScript (see the `TunableSpec` doc comment above).
 */
export interface TranscriptionConfig {
  engine_preference: TranscriptionEnginePreference;
  worker_mode: TranscriptionWorkerMode;
  cloud_order: string[];
  /**
   * ISO 639-1 language code, optionally region-qualified (e.g. "en" or
   * "en-US") — threaded into every cloud provider call and the local
   * engine's language hint. `null`/absent means auto-detect (the default).
   *
   * Config-load-time validation warns (falls back to auto-detect) on a
   * malformed value, and separately warns — but still accepts — a
   * non-English value combined with `engine_preference: 'local'`: the
   * bundled local model (`small.en`) is English-only and will silently
   * mistranscribe or transliterate non-English audio rather than error.
   */
  language?: string | null;
}

/**
 * The optional `browser:` block (AI-246 WP-D). Always resolved to defaults in
 * loadConfig — like bg_tasks — so consumers read a concrete port. `cdp_port`
 * is the Chrome DevTools port PA launches its headed browser-session Chrome
 * with; Playwright MCP attaches to it via PLAYWRIGHT_MCP_CDP_ENDPOINT instead
 * of launching its own Chrome.
 */
export interface BrowserConfig {
  cdp_port: number;  // 1024..65535, default 9222
}

/**
 * PA's typed view of the optional `voice_inbox:` config block — only the keys
 * PA itself consumes. The voice-inbox app reads the same config.yaml keys
 * through its own loader (projects/voice-inbox/src/config.ts); the fallback
 * maintenance job reads inbox_topic/keyword_topics raw. This is NOT a
 * duplicate loader — one YAML file, two typed views.
 */
export interface VoiceInboxConfig {
  port?: number;                    // voice_inbox.port — app server bind port; consumers default to 8787
  screencast_ingest_token?: string; // voice_inbox.screencast_ingest_token — shared Bearer secret injected as PA_SCREENCAST_INGEST_TOKEN (AI-246)
}

export interface PaConfig {
  workers: WorkerConfig[];
  evaluator?: EvaluatorConfig;
  topic_defaults?: Record<string, string>;  // topicKey ("chatId_threadId") → worker name
  bg_tasks: BgTasksConfig;
  concurrency_limit?: number; // max parallel skills in catchup; undefined = follow the dynamic worker-slot cap
  maintenance?: Record<string, MaintenanceConfig>;
  transcription?: TranscriptionConfig;
  usage?: UsageConfig;
  cost_tier?: CostTierConfig;  // optional cost-tier window configuration
  routing_policy?: RoutingPolicyConfig;  // optional code/general turn-routing policy (absent = disabled)
  model_router?: ModelRouterConfig;  // optional model router (block absent = disabled; enabled only gates the decision, shadow runs on presence)
  quota_aware_failover?: boolean;  // opt-in flag for health-score-based worker ordering (default false)
  worker_pin?: string;  // persisted override for 'pa worker pin <name>'
  git_workflow?: GitWorkflowConfig;  // absent = legacy git-allowed; see GitWorkflowConfig
  browser: BrowserConfig;          // always resolved (default cdp_port 9222), like bg_tasks
  voice_inbox?: VoiceInboxConfig;  // absent = the app is not configured; block is optional
}

export interface UsageConfig {
  budget_monthly_usd?: number;  // optional monthly budget in USD; parsed but alerting is not implemented yet — reserved for future budget alerts
}

/** Opt-in switch for skills that run git on the user's behalf (commit/push/
 *  revert). ABSENT = enabled: every config written before this knob existed
 *  (2026-08-31) keeps its git behavior; `pa init` scaffolds the block with
 *  enabled: false so NEW installs default to run-only (persona B). */
export interface GitWorkflowConfig {
  enabled: boolean;
}

export interface CostTierPeakWindowUtc {
  days?: number[];      // 0-6 (0=Sunday) — days of week treated as peak; default [1,2,3,4,5]
  start_hour?: number;  // 0-23 UTC — start of peak window; default 6
  end_hour?: number;    // 0-23 UTC — end of peak window; default 10 (must be > start_hour for v1)
}

export interface CostTierConfig {
  peak_window_utc?: CostTierPeakWindowUtc;  // optional peak window override; default Mon-Fri 06:00-10:00 UTC
}

/**
 * Request-routing policy (2026-09-11, plans/2026-09-11-model-routing-policy.md):
 * classifies each bot turn as code/engineering or general and overrides the
 * topic default with a time-window worker for code turns. Absent = disabled =
 * zero behavior change. Worker names must exist in `workers:` (load warns and
 * resolve fails open to the topic default otherwise). Peak window is NOT
 * configured here — `cost_tier.peak_window_utc` is the single window truth.
 */
export type RoutingJudgeType = 'typesafe' | 'agy' | 'deterministic';

export interface RoutingPolicyConfig {
  enabled: boolean;
  judge?: RoutingJudgeType;
  judge_model?: string;
  judge_timeout_ms?: number;
  judge_command?: string;
  /** General-classified turns on topics with NO configured topic default
   *  (otherwise they already fall to the first-priority worker). */
  general_worker?: string;
  /** Code-classified turns outside the peak window. */
  code_worker?: string;
  /** Code-classified turns inside the peak window. */
  peak_code_worker?: string;
  /** Extra regex sources appended to the built-in code signals (invalid
   *  sources are dropped with a warning at config load). */
  code_patterns?: string[];
  /** Per-topic classification pin: 'code' | 'general' always classify that
   *  way, 'off' excludes the topic from the policy. */
  topic_classes?: Record<string, 'code' | 'general' | 'off'>;
}

/**
 * Model router (2026-09-18, plans/2026-09-18-model-router-SPEC.md). Absent
 * block = zero behavior, zero logging. Shadow runs iff the block EXISTS
 * (regardless of `enabled`); `enabled: true` additionally lets the router
 * DECIDE. Worker names in table/effort_projection are NOT validated at load —
 * the router's availability layer re-checks fleet membership at resolve time
 * and fails open.
 */
export type CapabilityTier = 'quick_lookup' | 'standard' | 'deep_reasoning' | 'rich_toolchain';
export type EffortScore = 1 | 2 | 3 | 4 | 5;
export interface ModelRouterPolicyRow {
  worker: string;
  model?: string;            // omitted = the worker's configured default model
  max_tier: CapabilityTier;  // highest tier this row satisfies
  max_score: EffortScore;    // highest effort Score this row can express
}
export interface ModelRouterEffortProjection {
  tunable: 'effort' | 'none'; // 'none' = worker has NO effort knob (agy/agyc/devin)
  map?: Partial<Record<EffortScore, string>>; // when tunable === 'effort'
}
export interface ModelRouterConfig {
  enabled: boolean;
  judge?: 'typesafe';            // only value this wave; reserved
  state_max_chars?: number;      // default 4000
  context_max_chars?: number;    // default 2000
  topic_max_chars?: number;      // default 300
  zai_workers?: string[];        // default ['zclaude']
  /** Conversation stickiness (intent decision 19): absent = ON when the block
   *  exists — keep the incumbent worker while the turn's needs stay inside its
   *  capability envelope; escapes are capability-UP/unavailable/peak-zai-last
   *  only. `sticky: false` opts out and every turn resolves fresh. */
  sticky?: boolean;
  table?: ModelRouterPolicyRow[];
  effort_projection?: Record<string, ModelRouterEffortProjection>;
  shadow_path?: string;          // default paHome()/model-router-shadow.jsonl
  /** Pin deprecation (2026-09-19 router-as-orchestrator intent decision 25):
   *  absent + block present = true (pins are no-ops for TURN DISPATCH on
   *  router-decided turns); explicit `false` = today's behavior. */
  deprecate_pins?: boolean;
  /** Availability cache TTL in ms (decision 27), default 5000; `0` disables
   *  the cache (always fresh). Env override PA_MODEL_ROUTER_AVAILABILITY_TTL_MS. */
  availability_ttl_ms?: number;
  /** Placement candidate caps (decision 21): reader list cap, per-candidate
   *  goal cap, and the classifier's prompt-assembly section cap. */
  placement?: {
    candidate_cap?: number;   // default 25
    goal_chars?: number;      // default 80
    section_chars?: number;   // default 2400
  };
  /** Per-surface staging (decision 28): absent surface = 'shadow' (dark —
   *  recorded, never acted on). Flips one config edit at a time. */
  surfaces?: {
    fallback?: 'shadow' | 'live';
    steer?: 'shadow' | 'live';
    placement?: 'shadow' | 'live';
  };
}

export interface WorkerHealthState {
  workerName: string;
  isCoolingDown: boolean;
  consecutiveFailures: number;  // from logs/latest.json
  cooldownUntil?: string;       // ISO timestamp if cooling
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
  agentName?: string;  // name of the agent (e.g. agy, claude)
  isEvaluator?: boolean; // prevents recursive LLM evaluation of the evaluator itself
  // Admission-control slot priority (2026-09-11): 'routing' waiters poll for a freed
  // worker slot every 250ms instead of the 5s normal cadence. Set ONLY for short-lived
  // routing dispatches (the bot's voice-routed thread executor does); skill and
  // conversation dispatches stay unset. Forwarded by runWithFailover's options spread;
  // deliberately NOT set by commands/run.ts's preferred-worker path.
  slotPriority?: 'routing' | 'normal';
  onWorkerSwitch?: (payload: FailoverNotifyPayload) => Promise<void>;
  checkAvailable?: (worker: WorkerConfig) => Promise<boolean>;
  preferredWorker?: string;  // preferred worker name (e.g. "codex") to try first
  candidateOrder?: string[];  // decision 20: routed turns — replaces the static priority order
  ignoreWorkerPin?: boolean;  // decision 25: skip config.worker_pin reordering on this dispatch
  excludeWorkers?: Set<string>; // workers to skip (already failed in earlier dispatch phases)
  updateId?: number; // Telegram update_id for log correlation
  suppressExitAlert?: boolean; // suppress worker-exit notify for intermediate failover attempts
  // Caller-side cancellation probe, polled by runWithFailover before every
  // attempt and again after a failed one, and by executeWorker's exit-alert
  // path. Returns true once the CALLER has abandoned this request (Telegram
  // /stop, /steer) — distinct from the worker failing on its own. Synchronous
  // by design: it is read inside the child's close handler.
  isCancelled?: () => boolean;
  noFallback?: boolean; // when true, stop on first failure instead of continuing to next worker
  // When true, a worker that exits 0 with empty/whitespace-only output is
  // treated as FAILED inside the failover loop (log + continue to the next
  // worker) instead of being returned as success. Set by callers whose
  // dispatch MUST produce output (run.ts sets it for skills declaring
  // telegram_output — the isSilentNoOp class, moved up from post-run
  // reclassification so a silent worker fails over instead of ending the
  // cascade. 2026-08-21.) The NO_OUTPUT sentinel is non-empty output and
  // passes this check.
  requireNonEmptyOutput?: boolean;
  priorAttempts?: string[]; // workers that already failed before runWithFailover was invoked
  contextId?: string; // execution-context UUID; allows nested same-context blackboard lock re-entrancy
  getExtraArgs?: (worker: WorkerConfig) => string[] | undefined; // dynamic extraArgs resolver per failover candidate
  /** Per-hop env keys, evaluated per failover hop with that hop's WorkerConfig —
   *  merged AFTER `env` so the hop's own identity wins over any static value.
   *  This is ALSO the only place non-secret dispatch env survives: runWithFailover
   *  replaces `env` with the hop's secret_allowlist-filtered subset, which drops
   *  every non-allowlisted key before it reaches the child. Semantics mirror
   *  getExtraArgs (WS3 answer provenance, 2026-09-18). */
  getEnv?: (worker: WorkerConfig) => Record<string, string> | undefined;
  // Flag names removed from the worker's CONFIGURED args for THIS run only
  // (stripConfiguredArgs in worker-exec.ts). Bare form ('--flag value') drops
  // the flag AND its following token unconditionally; '--flag=value' drops the
  // token; repeated occurrences all drop; a stripped flag at the end of args
  // drops itself. Unset/empty ⇒ args pass through byte-identical. NEVER touches
  // extraArgs/getExtraArgs output — those are appended AFTER stripping. Applied
  // at executeWorker's single args-assembly site; runWithFailover candidates
  // inherit it through the options spread. Consumer (2026-09-06): the bot's
  // spawned-thread dispatches strip '--append-system-prompt-file' from
  // claude/zclaude so a thread does not receive the operator's static
  // bot-instructions file.
  stripArgs?: string[];
  // AI-114: when set, stamps a harvestUntil deadline (now + this) onto the
  // worker-pids registry entry, protecting it from cleanupOrphanedWorkers'
  // periodic sweep (every 60s via `pa catchup`, no excludeSkills of its own)
  // for as long as a tracked pid stays alive. Tie this to the caller's own
  // harvest budget (e.g. the bot's orphan-dispatch reaper's REAP_MAX_WAIT_MS)
  // plus slack — `pa run` skill dispatches leave it unset, keeping today's
  // kill-within-60s hygiene.
  harvestWindowMs?: number;
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
  description?: string;         // Human-readable one-liner shown in /skills and pa surfaces
  inject_triggers?: boolean;     // if true, inject all other skills' trigger_descriptions into this skill's prompt
  worker?: string;               // preferred worker for this skill (e.g. "claude", "agy", "zclaude")
  no_fallback?: boolean;         // when true, don't failover to other workers on failure
  cmd?: string;                  // direct shell command to execute (bypasses LLM if set)
  topic?: string;                // optional custom topic name for partitioning (replaces queue/priority)
  telegram_output?: TelegramOutput; // if set, pa run delivers LLM output to this Telegram chat/thread
  critical?: boolean;            // if true, self-improver never autonomously approves changes targeting this skill
  worker_args?: string[];        // extra CLI args appended to the worker command for THIS skill only (e.g. agy --include-directories to widen its file-tool workspace beyond the shim-forced repo cwd). Merged ahead of run-time extraArgs.
  exclusive_resource?: string;   // when set, pa run serializes this skill against every OTHER skill declaring the same resource name via a blackboard lock (e.g. "git-workflow" for commit/push/push-public/investigate-flagged, which all mutate the same working tree). Do NOT set this on a skill that itself invokes `pa run` on another skill declaring the same resource — the child would deadlock waiting for the parent's own lock.
  worktree_cwd?: boolean;        // when true, pa run lets a caller inside a LINKED WORKTREE of the declared cwd's repo redirect the worker into the caller's own toplevel (resolveWorkerTreeRoot; AI-320). Off by default: skills that push refs or inspect main-branch state (push/push-public) must stay pinned to the declared checkout until their branch semantics are reviewed.
  cost_tier?: 'off_peak' | 'anytime';  // default 'anytime'; off_peak skills run only during z.ai off-peak window (19:30-11:30 IST). Periodic off_peak skills are deferred during peak hours with once-daily logging.
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
  // 2026-08-23 (alert-census wave, plans/2026-08-23-alerts-wave-SPEC.md): what `target_skill`
  // names. Default/undefined = 'skill' (a ~/.pa/skills entry). 'maintenance-job' = a declared
  // maintenance job (pa/src/lib/maintenance/registry.ts) whose name is in `target_skill` and
  // whose source file is in `code_target` — routed straight to code-fixer.ts (no skill.md exists
  // to prompt-fix), verified by the pa build+suite, rolled back on the job's ledger failures.
  target_kind?: 'skill' | 'maintenance-job';
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
  sessionId?: string; // CLI session ID (Claude: from NDJSON stream; agy: undefined, discovered from disk)
  evaluatorSummary?: string; // user-facing summary from LLM evaluator (set on both kill and done verdicts)
  alreadyAlertedPaSupport?: boolean; // true when runWithFailover already emitted exhaustion/wall alert
  rateLimitTelemetry?: {
    usedPercent: number;
    windowMinutes: number;
    resetsAt: number; // unix seconds
  };
  /** Path to the tee file capturing this dispatch's stdout (for crash
   * recovery). Undefined when no tee was set up. */
  teePath?: string;
  /** Per-execution uuid minted by executeWorker. Joins this run to its line in
   * ~/.pa/turn-traces.jsonl and to the archive row the bot writes for the turn
   * (2026-08-24, plans/2026-08-24-recall-traces-wave-SPEC.md). Present on every
   * executeWorker return, including failures. */
  runId?: string;
  /** Raw-send guard (2026-09-04, plans/2026-09-04-raw-send-guard-SPEC.md): tool
   * commands from this run that hit the Telegram Bot API directly
   * (api.telegram.org / telegramFetch). Present only when the detector matched
   * — the bot turns this into one best-effort pa-support alert and never
   * blocks the reply on it. */
  rawTelegramSends?: string[];
  /** Auth-shaped lines in this run's output (auth broker Phase A, 2026-09-10).
   *  Present only when the detector matched — the bot turns this into ONE
   *  best-effort nudge and never blocks the reply on it. */
  authPrompts?: string[];
}
