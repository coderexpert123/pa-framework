import { readAuditRecords, skillRunStats } from '../lib/improvement-audit.js';
import type { AuditRecord, SkillRunStats } from '../lib/improvement-audit.js';

const DEFAULT_SINCE_DAYS = 30;

// Actions worth evaluating — a change actually reached production (applied-fix,
// approved-new-skill, applied-code-fix) or was undone (rolled-back). Everything else
// (rejected_auto, rejected_stale, validation-failed, the code-fix skip/revert reasons)
// never left a change live, so there's nothing to eval a before/after delta against.
const EVALUABLE_ACTIONS: ReadonlySet<AuditRecord['action']> = new Set(['applied-fix', 'approved-new-skill', 'applied-code-fix', 'rolled-back']);

export interface EvalEntry {
  record: AuditRecord;
  current: SkillRunStats;
}

function fmtStats(s: { runs: number; successes: number; failures: number }): string {
  return `${s.runs} runs, ${s.successes} success, ${s.failures} fail`;
}

function fmtDelta(baseline: { successes: number; failures: number }, current: { successes: number; failures: number }): string {
  const dSucc = current.successes - baseline.successes;
  const dFail = current.failures - baseline.failures;
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return `delta: ${sign(dSucc)} success, ${sign(dFail)} fail`;
}

/**
 * Formats the eval report. Pure function (no I/O) so the formatting/delta logic is testable
 * without fixture audit files on disk — mirrors self-improver.ts's buildReport()/console.log
 * split. The before/after delta (record.baseline, recorded at apply/rollback time, vs.
 * `current`, computed fresh over the same window) IS the eval: it answers "did this change
 * actually help?" without relying on the self-improver's own (potentially self-serving)
 * judgment of its own change.
 */
export function buildEvalReport(entries: EvalEntry[], sinceDays: number): string {
  const lines: string[] = [];
  lines.push(`Self-Improvement Eval — applied/rolled-back changes in the last ${sinceDays} days\n`);

  if (entries.length === 0) {
    lines.push('No applied or rolled-back changes in this window.');
    return lines.join('\n');
  }

  for (const { record, current } of entries) {
    const date = record.ts.slice(0, 10);
    const target = record.target_skill ?? `${record.draft} (new)`;
    const riskSuffix = record.risk_flags.length > 0 ? `  risk: ${record.risk_flags.join(', ')}` : '';

    lines.push(`${date}  ${record.draft}  [${record.action}]${riskSuffix}`);
    lines.push(`  target: ${target}`);
    // Code fixes are git commits, not skill.md overwrites — surface the hash(es) so the
    // eval reader can `git show` the exact change (and its revert, when rolled back).
    if (record.action === 'applied-code-fix' && record.commit_hash) {
      lines.push(`  commit ${record.commit_hash}${record.files_changed ? `, ${record.files_changed.length} file(s) changed` : ''}`);
    }
    if (record.action === 'rolled-back' && record.commit_hash) {
      lines.push(`  reverted commit ${record.commit_hash}${record.revert_commit_hash ? ` (revert: ${record.revert_commit_hash})` : ''}`);
    }
    if (record.baseline) {
      lines.push(`  baseline (${record.baseline.window_days}d @ apply): ${fmtStats(record.baseline)}`);
      lines.push(`  current  (${record.baseline.window_days}d now):     ${fmtStats(current)}`);
      lines.push(`  ${fmtDelta(record.baseline, current)}`);
    } else {
      lines.push(`  current (${sinceDays}d now): ${fmtStats(current)} (no baseline recorded — newly created)`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export async function improvementsCommand(sinceDays: number = DEFAULT_SINCE_DAYS): Promise<void> {
  const all = await readAuditRecords();
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const relevant = all
    .filter((r) => EVALUABLE_ACTIONS.has(r.action) && new Date(r.ts).getTime() >= cutoff)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  const entries: EvalEntry[] = [];
  for (const record of relevant) {
    // A fix/rollback evaluates its target_skill; a brand-new skill (no target_skill) was
    // deployed under its own draft name (approveDraft copies skillsDir()/<name>), so it
    // evaluates itself.
    const skillName = record.target_skill ?? record.draft;
    const windowDays = record.baseline?.window_days ?? sinceDays;
    const current = await skillRunStats(skillName, windowDays);
    entries.push({ record, current });
  }

  console.log(buildEvalReport(entries, sinceDays));
}
