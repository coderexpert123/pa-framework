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
