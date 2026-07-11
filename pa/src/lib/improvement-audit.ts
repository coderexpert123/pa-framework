import { appendFile, readFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../paths.js';
import { readLogs } from '../logger.js';

// ---------------------------------------------------------------------------
// Eval-grade audit trail for the self-improvement loop (2026-07-11 full-
// autonomy regime — see plans/2026-07-11-autonomous-self-improver-full-
// autonomy.md). Every terminal decision self-improver.ts's gateAndApprove()
// or rollback() makes appends one line here; pa/src/commands/improvements.ts
// reads it back to compute a before/after eval per applied change.
// ---------------------------------------------------------------------------

export interface AuditValidation {
  new_run_ok?: boolean;
  judge_verdict?: boolean;
  judge_excerpt?: string; // truncated to ~300 chars by the caller
}

export interface AuditBaseline {
  window_days: number;
  runs: number;
  successes: number;
  failures: number;
}

// Test-run counts from the post-apply verification gate (code-fixer.ts's F3) — separate from
// AuditBaseline (which is run/success/failure counts of the target SKILL's own history, not
// the test suite that validated the fix).
export interface AuditTestRunCounts {
  total: number;
  pass: number;
  fail: number;
  skip: number;
}

export interface AuditRecord {
  ts: string;
  draft: string;
  source_type: 'conversation' | 'failure' | 'feedback';
  target_skill?: string;
  action: 'applied-fix' | 'approved-new-skill' | 'rejected_auto' | 'rejected_stale' | 'rolled-back' | 'validation-failed'
    // Autonomous CODE-fix capability (2026-07-11) — see
    // plans/2026-07-11-autonomous-code-fix-capability.md. code-fixer.ts's attemptCodeFix()
    // appends one of these for every terminal branch, mirroring gateAndApprove's own
    // one-audit-record-per-decision convention.
    | 'applied-code-fix'
    | 'code-fix-skipped-dirty-worktree'
    | 'code-fix-skipped-worker-failed'
    | 'code-fix-skipped-no-changes'
    | 'reverted-protected-path'
    | 'reverted-test-weakening'
    | 'reverted-verification-failed'
    // self-improver.ts's rollback() extension (Commit 3) — a prior applied-code-fix commit
    // whose target skill is now failing at an elevated rate gets `git revert`-ed.
    | 'rollback-failed';
  risk_flags: string[];
  reason: string;
  validation?: AuditValidation;
  diff?: string;         // unified diff (fix) or the full new prompt (new skill) — ≤4000 chars
  backup_path?: string;
  baseline?: AuditBaseline;
  commit_hash?: string;         // the fix commit's hash (applied-code-fix only)
  revert_commit_hash?: string;  // set when a prior applied-code-fix commit is `git revert`-ed (rolled-back action)
  files_changed?: string[];     // repo-relative paths touched by a code fix
  evidence_excerpt?: string;    // truncated failure evidence (readRecentFailures) that justified a code fix — ≤2000 chars
  test_run_counts?: AuditTestRunCounts; // F3 verification-gate suite results, when the fix passed far enough to run them
}

/**
 * Appends one JSON line to ~/.pa/self-improver-audit.jsonl. Fail-soft — matches
 * rate-limit-unparseable-log.ts's convention: an audit-write failure must never crash the
 * self-improvement loop or block a decision that has already been made and applied.
 */
export async function appendAuditRecord(record: AuditRecord): Promise<void> {
  try {
    const path = join(paHome(), 'self-improver-audit.jsonl');
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.warn('[improvement-audit] failed to write audit record:', err);
  }
}

/**
 * Reads and parses the full audit trail. Used by self-improver.ts's cooldown check
 * (Phase D thrash control) and pa/src/commands/improvements.ts's eval report. Malformed
 * lines are skipped rather than failing the whole read — an audit trail growing unbounded
 * over time should degrade gracefully, not become a single point of failure. Missing file
 * (no changes applied yet) returns an empty array, not an error.
 */
export async function readAuditRecords(): Promise<AuditRecord[]> {
  let raw: string;
  try {
    raw = await readFile(join(paHome(), 'self-improver-audit.jsonl'), 'utf8');
  } catch {
    return [];
  }

  const records: AuditRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch {
      // skip corrupt line
    }
  }
  return records;
}

export interface SkillRunStats {
  windowDays: number;
  runs: number;
  successes: number;
  failures: number;
}

// Generous cap on how many of a skill's most-recent .meta files readLogs() will consider —
// matches failure-analyzer.ts's ROLLBACK_LOG_SAMPLE_SIZE tradeoff: a very-high-frequency
// skill's true N-day window could exceed this, silently truncating the stat window to less
// than `days`. Accepted here since this feeds a human-read eval report (pa improvements),
// not an automated safety decision, and reading a few hundred small .meta files is cheap.
const BASELINE_LOG_SAMPLE_SIZE = 500;

/** Run/success/failure counts for `skillName` within the last `days` days, derived from its
 * logsDir()/*.meta files (RunMeta.status). Used as the "baseline" (at apply/rollback time)
 * and, later, the "current" (at eval time) snapshot that pa improvements diffs against each
 * other — the delta between the two IS the eval. */
export async function skillRunStats(skillName: string, days: number): Promise<SkillRunStats> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const logs = await readLogs(skillName, BASELINE_LOG_SAMPLE_SIZE);

  let runs = 0;
  let successes = 0;
  let failures = 0;
  for (const { meta } of logs) {
    if (new Date(meta.timestamp).getTime() < cutoff) continue;
    runs++;
    if (meta.status === 'success') successes++;
    else if (meta.status === 'error') failures++;
    // 'rate_limited' counts toward runs but neither bucket — it's not a fix-relevant outcome.
  }

  return { windowDays: days, runs, successes, failures };
}

/** Maps SkillRunStats' camelCase field names to AuditBaseline's snake_case JSONL schema —
 * keeps the naming-convention boundary (idiomatic JS internally, the audit file's own fixed
 * on-disk shape) in one place rather than repeating the mapping at every call site. */
export function toAuditBaseline(stats: SkillRunStats): AuditBaseline {
  return { window_days: stats.windowDays, runs: stats.runs, successes: stats.successes, failures: stats.failures };
}

/**
 * A minimal unified-diff-style line differ (LCS-based) — good enough for a human-read audit
 * trail entry, not a byte-perfect implementation of the unified diff spec. No diff library is
 * a pa dependency; adding one for a single JSONL field wasn't worth the new dependency
 * surface. O(n*m) in line count — fine for skill-prompt-sized inputs (tens to low hundreds of
 * lines), not intended for arbitrary large text.
 */
export function unifiedDiff(oldText: string, newText: string, maxChars = 4000): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;

  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${oldLines[i]}`);
      i++;
    } else {
      out.push(`+ ${newLines[j]}`);
      j++;
    }
  }
  while (i < m) { out.push(`- ${oldLines[i]}`); i++; }
  while (j < n) { out.push(`+ ${newLines[j]}`); j++; }

  const joined = out.join('\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n... (truncated)` : joined;
}
