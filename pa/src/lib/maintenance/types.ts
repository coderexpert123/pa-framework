/**
 * Declared maintenance jobs (AI-100).
 *
 * THE RULE: any recurring work that mutates durable state beyond the lifetime
 * of one in-flight operation must be declared here. Timers scoped to a single
 * operation with no durable side effect are exempt only via an explicit entry
 * in pa/tests/timer-inventory.test.ts's TIMER_ALLOWLIST, carrying a reason.
 *
 * Context: on 2026-08-02 an undeclared 6-hour timer buried in the Telegram
 * bot's poll loop deleted 248 of the operator's real Claude Code transcripts.
 * A repo-wide audit then found 17 pieces of undeclared recurring maintenance,
 * 9 of which delete or archive data. This construct exists so that class of
 * defect is a build failure, not a production incident.
 */

export type MaintenanceHost = 'pa' | 'bot';

export type RetentionAction = 'delete' | 'archive';

/**
 * Why PA is entitled to touch this path at all.
 *  - 'pa-owned'              : PA created it and is the sole writer.
 *  - 'external-no-retention' : another tool owns it but ships NO retention
 *                              policy of its own, so PA prunes on its behalf.
 * A tool that self-manages retention is neither — it belongs in
 * FORBIDDEN_ROOTS (policy.ts), not in a target.
 */
export type RetentionOwnership = 'pa-owned' | 'external-no-retention';

export interface RetentionTarget {
  /** Resolved at RUN TIME, never import time — PA_HOME/homedir must be read
   *  when the job runs, not when the module loads (tests override PA_HOME). */
  resolve: () => string;
  /** Fail-closed filename filter. A file that does not match is NEVER touched. */
  match: RegExp;
  /** Retention window used by the dry-run previewer to select candidates. */
  maxAgeMs: number;
  action: RetentionAction;
  ownership: RetentionOwnership;
  /** Dated justification, e.g. "agy ships no retention policy (audit 2026-08-02)". */
  evidence: string;
  /** Optional: how the job ACTUALLY selects within this target, when that
   *  differs from plain mtime-vs-maxAgeMs (e.g. liveness-based reaping).
   *  Printed by `pa maintenance list`; keeps the preview honest. */
  note?: string;
}

export interface MaintenanceJobContext {
  /** Wall clock for this pass. Jobs MUST use this, never Date.now(), so tests
   *  can drive time without a clock library. */
  now: number;
  /** Cadence resolved for this pass (declared value after any config override). */
  everyMs: number;
}

export interface MaintenanceJobResult {
  /** Items acted on. 0 is normal and is deliberately NOT logged (see runner). */
  touched: number;
  detail?: Record<string, unknown>;
}

export interface MaintenanceJob {
  /** Stable identifier. Doubles as a config key, a CLI argument and a notify
   *  dedup key, so: /^[a-z0-9][a-z0-9-]*$/ */
  name: string;
  host: MaintenanceHost;
  /** Declared cadence in ms. Function form is evaluated once per pass. */
  everyMs: number | (() => number);
  description: string;
  /** True if the job deletes or archives durable data. MUST have >=1 target. */
  destructive: boolean;
  /** False means "never shed, even under DEGRADED" — reserve for work that IS
   *  the product (e.g. reply delivery), not housekeeping. */
  shedWhenDegraded: boolean;
  targets: RetentionTarget[];
  run(ctx: MaintenanceJobContext): Promise<MaintenanceJobResult>;
}

export type SkipReason = 'disabled' | 'degraded' | 'in-flight' | 'not-due';

export type JobOutcome = 'ran' | 'failed' | 'skipped';

export interface JobRunRecord {
  name: string;
  outcome: JobOutcome;
  touched?: number;
  skipReason?: SkipReason;
  error?: string;
  durationMs: number;
  detail?: Record<string, unknown>;
}

/** Operator override from config.yaml's `maintenance:` block. May only DISABLE
 *  a job or CHANGE ITS CADENCE — never add/widen a target, flip `destructive`,
 *  or clear `shedWhenDegraded: false`. */
export interface MaintenanceOverride {
  enabled?: boolean;
  everyMs?: number;
}

export type MaintenanceOverrides = Record<string, MaintenanceOverride>;

/** One target's read-only dry-run preview. */
export interface RetentionPreview {
  target: RetentionTarget;
  resolvedPath: string;
  exists: boolean;
  /** Absolute paths matching `match` whose mtime is older than now - maxAgeMs.
   *  Empty when the target is not a directory. */
  candidates: string[];
  /** Set when candidates could not be enumerated (non-directory target, e.g. a
   *  SQLite file whose rows readdir cannot see; or an unreadable directory). */
  note?: string;
}
