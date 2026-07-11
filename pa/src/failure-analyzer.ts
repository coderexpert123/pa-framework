import { readdir, stat, readFile } from 'fs/promises';
import { join } from 'path';
import { logsDir, draftsDir } from './paths.js';
import { readLogs } from './logger.js';
import { listSkills } from './skills.js';
import { listDrafts, isDuplicate, computeFingerprint, uniqueDraftName } from './drafts.js';
import { readAuditRecords } from './lib/improvement-audit.js';
import { runWithFailover } from './workers.js';
import { parseProposalResponse } from './analyzer.js';
import { notifyUser } from './lib/notify.js';
import type { DraftProposal, DraftMeta, RunMeta } from './types.js';

export interface FailureRecord {
  skillName: string;
  error: string;
  timestamp: string;
  duration: number;
  worker: string;
}

export async function readRecentFailures(days: number): Promise<FailureRecord[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const failures: FailureRecord[] = [];

  let skillDirs: string[];
  try {
    skillDirs = await readdir(logsDir());
  } catch {
    return [];
  }

  for (const skillName of skillDirs) {
    // Skip non-directory entries (e.g. telegram-bot.log)
    try {
      const s = await stat(join(logsDir(), skillName));
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    let logs: Array<{ meta: RunMeta; logPath: string }>;
    try {
      logs = await readLogs(skillName, 50);
    } catch {
      continue;
    }

    for (const { meta } of logs) {
      if (meta.status !== 'error') continue;
      if (new Date(meta.timestamp) < cutoff) continue;
      failures.push({
        skillName,
        error: meta.error || 'unknown error',
        timestamp: meta.timestamp,
        duration: meta.duration,
        worker: meta.worker,
      });
    }
  }

  return failures;
}

export function buildFailurePrompt(
  failures: FailureRecord[],
  existingSkills: string[],
  existingDrafts: string[]
): string {
  // Group by skill name and error type
  const bySkill = new Map<string, { count: number; errors: string[]; latest: string }>();
  for (const f of failures) {
    const key = f.skillName;
    const existing = bySkill.get(key);
    if (existing) {
      existing.count++;
      if (!existing.errors.includes(f.error)) existing.errors.push(f.error);
      if (f.timestamp > existing.latest) existing.latest = f.timestamp;
    } else {
      bySkill.set(key, { count: 1, errors: [f.error], latest: f.timestamp });
    }
  }

  const failureBlock = Array.from(bySkill.entries())
    .filter(([, v]) => v.count >= 2)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([skill, v]) => `- **${skill}**: ${v.count} failures\n  Errors: ${v.errors.map((e) => `"${e}"`).join(', ')}\n  Last failed: ${v.latest}`)
    .join('\n');

  const exclusionList = [...existingSkills, ...existingDrafts].join(', ') || 'none';

  return `You are analyzing a personal assistant's skill execution failures to identify patterns that warrant a fix.

## Recent Skill Failures (skills with 2+ failures)

${failureBlock || '(no qualifying failures in this period)'}

## Existing Skills
${exclusionList}

## Task

For each failing skill pattern above, propose ONE of:
1. A modified skill prompt that addresses the root cause. Name the draft "<skill-name>-fix" and set "target_skill" to the exact existing skill name being fixed — this proposal will *replace* that skill's behavior, not create a new one.
2. A diagnostic skill that investigates why the failure keeps happening. This is a brand-new, standalone skill unrelated to any existing one — set "target_skill" to null.

Only propose fixes for patterns with 2+ failures. Ignore transient errors (network timeouts on a single day, etc.). The "target_skill" field is REQUIRED on every proposal (either the exact existing skill name for option 1, or the literal JSON value null for option 2) — never omit it.

If the failure evidence clearly points to a specific source file (e.g. a Python script path mentioned in a traceback or error message) that most likely causes the recurring failure, include it as "code_target": a repo-relative file path such as "projects/daily-mail-brief/scripts/run_brief.py". Omit "code_target" (or set it to null) whenever you are not confident of the exact file — it is optional and most proposals should leave it out.

Respond with ONLY a JSON array (no markdown fences, no explanation):

[
  {
    "name": "skill-name-fix",
    "reason": "Why this fix addresses the failure pattern (1-2 sentences)",
    "source_message_ids": [],
    "target_skill": "skill-name",
    "code_target": null,
    "frontmatter": {
      "timeout": 600,
      "idle_timeout": 180
    },
    "prompt": "The revised skill prompt in markdown"
  }
]

If no fixes are warranted, respond with: []`;
}

export async function analyzeFailurePatterns(
  days: number = 14,
  runner: typeof runWithFailover = runWithFailover
): Promise<DraftProposal[]> {
  const failures = await readRecentFailures(days);

  // Short-circuit: no qualifying failures (need 2+ from same skill)
  const countPerSkill = new Map<string, number>();
  for (const f of failures) {
    countPerSkill.set(f.skillName, (countPerSkill.get(f.skillName) || 0) + 1);
  }
  const hasQualifying = Array.from(countPerSkill.values()).some((c) => c >= 2);
  if (!hasQualifying) return [];

  const skills = await listSkills();
  const drafts = await listDrafts();

  const existingSkills = skills.map((s) => s.name);
  const existingDrafts = drafts.map((d) => d.skill.name);

  const prompt = buildFailurePrompt(failures, existingSkills, existingDrafts);

  const { result } = await runner(prompt, {
    resource: 'skill-failure-analyzer',
    timeout: 300,
    idleTimeout: 120,
  });

  if (!result.success) {
    await notifyUser(
      'Failure analyzer terminal failure',
      `The failure pattern analyzer LLM run failed.\nError: ${(result.error ?? 'unknown').slice(0, 300)}`,
      { dedupKey: 'failure-analyzer-terminal', severity: 'error' },
    ).catch(() => {});
  }

  const proposals = parseProposalResponse(result.output);

  // Deduplicate within batch and against saved state
  const seenNames = new Set<string>();
  const seenFingerprints = new Set<string>();
  const unique: DraftProposal[] = [];

  for (const proposal of proposals) {
    // Fix/reinforce proposals (target_skill set) must never collide on the fixed
    // "<target>-fix" name with an earlier, unrelated fix for the same skill — that would
    // make isDuplicate()'s by-name check silently drop a genuinely new fix forever after
    // the first one. New-skill/diagnostic proposals (no target_skill) keep the original
    // "name collision = duplicate idea" semantics.
    if (proposal.target_skill) {
      proposal.name = await uniqueDraftName(proposal.name);
    }
    const fingerprint = computeFingerprint(proposal.name, proposal.prompt);
    if (seenNames.has(proposal.name)) continue;
    if (seenFingerprints.has(fingerprint)) continue;
    if (await isDuplicate(proposal)) continue;
    seenNames.add(proposal.name);
    seenFingerprints.add(fingerprint);
    unique.push(proposal);
  }

  return unique;
}

export interface RollbackFlag {
  kind: 'restore' | 'delete' | 'git-revert';
  skillName: string;   // for 'restore': the target skill to restore; for 'delete': the skill to delete; for 'git-revert': the skill whose code fix gets reverted
  draftName: string;   // the draft whose meta.json records the change (used to update its status)
  commitHash?: string; // 'git-revert' only — the applied-code-fix commit to revert (from its audit record)
}

const ROLLBACK_FAILURE_RATE_THRESHOLD = 0.5; // >50% failures in the window
const ROLLBACK_WINDOW_DAYS = 1; // 24 hours
const ROLLBACK_LOOKBACK_DAYS = 7; // only consider autonomous changes reviewed within the last 7 days
const ROLLBACK_MIN_SAMPLE_SIZE = 3; // a single bad run (100% of n=1) must not trigger a rollback — need enough runs for the rate to mean anything
// 200, not the usual 50: this read specifically feeds a safety-critical rollback decision, and
// a hypothetical high-frequency autonomously-managed skill (e.g. running every few minutes)
// would otherwise have its "24 hour" window silently truncated to well under an hour by the
// default cap. No currently-deployed skill is affected, but the cost of reading a few hundred
// small .meta JSON files is negligible next to getting this decision right.
const ROLLBACK_LOG_SAMPLE_SIZE = 200;
// Never let the self-improvement loop roll back (restore or delete) itself, regardless of what
// the rest of this function's logic would otherwise conclude — matches the same protection
// validator.ts's PROTECTED_SKILLS and self-improver.ts's excludesSelf filter apply elsewhere.
// Currently also true structurally (self-improver was hand-authored, so it has no matching
// draftsDir() entry either path checks for) — this makes it true by explicit design as well.
const SELF_NAME = 'self-improver';

async function computeFailureRates(): Promise<Map<string, { total: number; failed: number }>> {
  const rates = new Map<string, { total: number; failed: number }>();
  let skillDirs: string[];
  try {
    skillDirs = await readdir(logsDir());
  } catch {
    return rates;
  }

  const cutoff = new Date(Date.now() - ROLLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  for (const skillName of skillDirs) {
    try {
      const s = await stat(join(logsDir(), skillName));
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    let logs: Array<{ meta: RunMeta; logPath: string }>;
    try {
      logs = await readLogs(skillName, ROLLBACK_LOG_SAMPLE_SIZE);
    } catch {
      continue;
    }

    let total = 0;
    let failed = 0;
    for (const { meta } of logs) {
      if (new Date(meta.timestamp) < cutoff) continue;
      total++;
      if (meta.status === 'error') failed++;
    }
    if (total >= ROLLBACK_MIN_SAMPLE_SIZE) rates.set(skillName, { total, failed });
  }

  return rates;
}

/**
 * Find autonomously-approved changes whose target skill is now failing at a high rate,
 * and flag them for rollback — restoring an in-place fix from its backup, or deleting a
 * brand-new autonomously-created skill entirely.
 */
export async function checkForRollbacks(): Promise<RollbackFlag[]> {
  const rates = await computeFailureRates();
  const flags: RollbackFlag[] = [];

  for (const [skillName, { total, failed }] of rates) {
    if (skillName === SELF_NAME) continue;
    if (failed / total <= ROLLBACK_FAILURE_RATE_THRESHOLD) continue;

    // First: is skillName itself the TARGET of a recent in-place fix? (applyFix overwrites
    // the target's own skillsDir()/<skillName>/skill.md, so the draft recording that fix
    // lives at a different path — search by meta.target_skill, not by directory name.)
    const inPlaceFixes = await listDrafts();
    const matchingFixes = inPlaceFixes.filter(
      (d) => d.meta.target_skill === skillName && d.meta.applied_in_place === true
        && d.meta.status === 'approved' && d.meta.reviewed_at
        && new Date(d.meta.reviewed_at) >= new Date(Date.now() - ROLLBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    );
    if (matchingFixes.length > 0) {
      const mostRecent = matchingFixes.reduce((a, b) =>
        (a.meta.reviewed_at! > b.meta.reviewed_at!) ? a : b);
      flags.push({ kind: 'restore', skillName, draftName: mostRecent.skill.name });
      continue;
    }

    // Second (2026-07-11, autonomous code-fix capability): did a recent applied-code-fix
    // commit target this skill? Code fixes live in git, not in a draft's backup file, so the
    // evidence is the audit trail — the most recent 'applied-code-fix' record for this skill
    // inside the lookback window supplies the commit hash to `git revert`. Checked AFTER the
    // in-place prompt-fix branch (restore is cheaper and more targeted when both exist).
    const codeFixes = (await readAuditRecords()).filter(
      (r) => r.action === 'applied-code-fix' && r.target_skill === skillName && r.commit_hash
        && new Date(r.ts) >= new Date(Date.now() - ROLLBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    );
    if (codeFixes.length > 0) {
      const mostRecent = codeFixes.reduce((a, b) => (a.ts > b.ts ? a : b));
      flags.push({ kind: 'git-revert', skillName, draftName: mostRecent.draft, commitHash: mostRecent.commit_hash });
      continue;
    }

    // Otherwise: was skillName itself deployed as a brand-new autonomously-approved skill?
    let meta: DraftMeta;
    try {
      meta = JSON.parse(await readFile(join(draftsDir(), skillName, 'draft.meta.json'), 'utf8'));
    } catch {
      continue; // not an autonomous change we know about — leave it alone
    }
    if (
      meta.status === 'approved'
      && meta.approved_autonomously === true
      && meta.applied_in_place !== true
      && meta.reviewed_at
      && new Date(meta.reviewed_at) >= new Date(Date.now() - ROLLBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    ) {
      flags.push({ kind: 'delete', skillName, draftName: skillName });
    }
  }

  return flags;
}
