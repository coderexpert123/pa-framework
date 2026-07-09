#!/usr/bin/env node
/**
 * Nightly self-improvement loop orchestrator.
 *
 * 1. Roll back any autonomous change from a prior night that's now causing elevated failures.
 * 2. Analyze the last N days of conversations, skill failures, and explicit user feedback for
 *    improvement proposals; persist every proposal as a pending draft.
 * 3. Gate each proposal: critical-skill or side-effecting proposals go to manual review;
 *    everything else is dry-run validated and, if it passes, autonomously approved/applied.
 * 4. Send a clean Markdown report directly via notifyUser() to the self-improvement-loop
 *    Telegram topic. NOT via the skill's `telegram_output` + raw-stdout auto-delivery: that
 *    path forwards the ENTIRE captured stdout of this process, including every internal
 *    `console.log`/`log()` line from imported modules (workers.ts's own "[INFO] [workers]
 *    try: ..." progress logging, rate-limit messages, heartbeats) — confirmed in production
 *    on the first real run, where the delivered message was a wall of that noise with the
 *    actual report buried at the end. self-improver's skill.md deliberately has no
 *    `telegram_output` for this reason; only this explicit notifyUser() call sends anything.
 */
import { analyzeConversationPatterns } from './analyzer.js';
import { analyzeFailurePatterns, checkForRollbacks } from './failure-analyzer.js';
import { analyzeFeedbackPatterns } from './feedback-analyzer.js';
import { saveDraft, markDraftMeta, approveDraft } from './drafts.js';
import { skillsDir, draftsDir } from './paths.js';
import { isCriticalChange, hasRealSideEffects, validateNewSkill, validateSkillFix, applyFix } from './validator.js';
import { notifyUser, getPaAlertsChatId, getPaAlertsThreadId } from './lib/notify.js';
import { rm, copyFile } from 'fs/promises';
import { join } from 'path';
import type { DraftProposal } from './types.js';

const SELF_NAME = 'self-improver';
// Env-driven so the framework is portable (matches lib/notify.ts's own
// PA_ALERTS_CHAT_ID pattern) — falls back to the general alerts topic when
// no dedicated self-improvement-loop topic is configured. Resolved lazily
// (at use, not module-load) for the same reason getPaAlertsChatId() is: CLI
// invocations may load secrets after this module is first imported.
function getReportTopic(): { chat_id: string; thread_id: number } {
  return {
    chat_id: process.env.PA_SELF_IMPROVER_CHAT_ID || getPaAlertsChatId(),
    thread_id: process.env.PA_SELF_IMPROVER_THREAD_ID
      ? Number(process.env.PA_SELF_IMPROVER_THREAD_ID)
      : getPaAlertsThreadId(),
  };
}
// Not 1 day: analyzeConversationPatterns/analyzeFailurePatterns require a pattern to repeat
// across *different* days (2-3+ occurrences) to qualify — a 1-day window would make that
// structurally impossible. "Nightly" describes run *cadence*, not the analysis window; the
// analyzers' own dedup (isDuplicate/fingerprint) already prevents re-proposing something
// already handled on a prior night. Matches the existing `pa learn` command's own default.
const ANALYSIS_DAYS = 14;

export interface ReportEntry {
  name: string;
  sourceType: 'conversation' | 'failure' | 'feedback';
  outcome: 'approved-new-skill' | 'applied-fix' | 'manual-review-critical' | 'manual-review-side-effects' | 'manual-review-validation-failed';
  reason: string;        // the proposal's own stated reason — what pattern triggered it, in plain language
  targetSkill?: string;  // for fix/reinforce proposals: which existing skill this touches or would touch
  detail?: string;
}

async function rollback(): Promise<string[]> {
  const flags = await checkForRollbacks();
  const lines: string[] = [];

  for (const flag of flags) {
    try {
      if (flag.kind === 'restore') {
        const backupPath = join(draftsDir(), flag.draftName, 'target-backup.skill.md');
        const targetPath = join(skillsDir(), flag.skillName, 'skill.md');
        await copyFile(backupPath, targetPath);
        await markDraftMeta(flag.draftName, { status: 'rejected_post_rollback' });
        lines.push(`- **Restored** \`${flag.skillName}\` to its pre-fix version (fix draft: \`${flag.draftName}\`) — elevated failure rate since the fix was applied.`);
      } else {
        await rm(join(skillsDir(), flag.skillName), { recursive: true, force: true });
        await markDraftMeta(flag.draftName, { status: 'rejected_post_rollback' });
        lines.push(`- **Deleted** autonomously-created skill \`${flag.skillName}\` — elevated failure rate since it was approved.`);
      }
    } catch (err: any) {
      lines.push(`- Rollback FAILED for \`${flag.skillName}\` (${flag.kind}): ${err.message}`);
    }
  }

  return lines;
}

async function generateProposals(): Promise<Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback' }>> {
  const [conversationProposals, failureProposals, feedbackProposals] = await Promise.all([
    analyzeConversationPatterns(ANALYSIS_DAYS),
    analyzeFailurePatterns(ANALYSIS_DAYS),
    analyzeFeedbackPatterns(ANALYSIS_DAYS),
  ]);

  // Belt-and-suspenders: never let a proposal targeting the self-improver itself reach the
  // validator, even though isCriticalChange's hardcoded PROTECTED_SKILLS check would also
  // catch it. conversation-based proposals never carry target_skill, so only failure/feedback
  // proposals need this filter.
  const excludesSelf = (p: DraftProposal) => p.name !== SELF_NAME && p.target_skill !== SELF_NAME;

  const tagged: Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback' }> = [
    ...conversationProposals.map((proposal) => ({ proposal, sourceType: 'conversation' as const })),
    ...failureProposals.filter(excludesSelf).map((proposal) => ({ proposal, sourceType: 'failure' as const })),
    ...feedbackProposals.filter(excludesSelf).map((proposal) => ({ proposal, sourceType: 'feedback' as const })),
  ];

  for (const { proposal, sourceType } of tagged) {
    await saveDraft(proposal, sourceType);
  }

  return tagged;
}

async function gateAndApprove(
  tagged: Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback' }>
): Promise<ReportEntry[]> {
  const entries: ReportEntry[] = [];

  for (const { proposal, sourceType } of tagged) {
    const base = { name: proposal.name, sourceType, reason: proposal.reason, targetSkill: proposal.target_skill };

    if (await isCriticalChange(proposal)) {
      entries.push({ ...base, outcome: 'manual-review-critical' });
      continue;
    }
    if (await hasRealSideEffects(proposal)) {
      entries.push({ ...base, outcome: 'manual-review-side-effects' });
      continue;
    }

    if (!proposal.target_skill) {
      const valid = await validateNewSkill(proposal);
      if (valid) {
        await approveDraft(proposal.name, { approved_autonomously: true });
        entries.push({ ...base, outcome: 'approved-new-skill' });
      } else {
        entries.push({ ...base, outcome: 'manual-review-validation-failed' });
      }
    } else {
      const valid = await validateSkillFix(proposal);
      if (valid) {
        await applyFix(proposal);
        entries.push({
          ...base,
          outcome: 'applied-fix',
          detail: `overwrote \`${proposal.target_skill}\` (backup: \`${proposal.name}/target-backup.skill.md\`)`,
        });
      } else {
        entries.push({ ...base, outcome: 'manual-review-validation-failed' });
      }
    }
  }

  return entries;
}

export function buildReport(rollbackLines: string[], entries: ReportEntry[]): string {
  const applied = entries.filter((e) => e.outcome === 'approved-new-skill' || e.outcome === 'applied-fix');
  const manualReview = entries.filter((e) => e.outcome.startsWith('manual-review'));

  const lines: string[] = [];
  lines.push(`Analyzed the last ${ANALYSIS_DAYS} days. ${entries.length} proposal(s) generated.`);
  lines.push('');

  if (rollbackLines.length > 0) {
    lines.push(`*Rollbacks (${rollbackLines.length})*`);
    lines.push(...rollbackLines);
    lines.push('');
  }

  if (applied.length > 0) {
    lines.push(`*Autonomously applied (${applied.length})*`);
    for (const e of applied) {
      const what = e.outcome === 'approved-new-skill' ? 'new skill' : `fix to \`${e.targetSkill}\``;
      lines.push(`- \`${e.name}\` (${e.sourceType}) — ${what}${e.detail ? `: ${e.detail}` : ''}`);
      lines.push(`  ↳ ${e.reason}`);
    }
    lines.push('');
  }

  if (manualReview.length > 0) {
    lines.push(`*Pending manual review (${manualReview.length})* — run \`pa drafts\` to inspect`);
    for (const e of manualReview) {
      const why = e.outcome === 'manual-review-critical' ? `targets a critical skill (\`${e.targetSkill}\`)`
        : e.outcome === 'manual-review-side-effects' ? 'has real side effects (declares secrets)'
        : e.targetSkill ? `proposed fix for \`${e.targetSkill}\`, but failed autonomous validation`
        : 'proposed new skill, but failed autonomous validation';
      lines.push(`- \`${e.name}\` (${e.sourceType}) — ${why}`);
      lines.push(`  ↳ ${e.reason}`);
    }
    lines.push('');
  }

  if (entries.length === 0 && rollbackLines.length === 0) {
    lines.push('Nothing to report — no qualifying patterns, no rollbacks.');
  }

  return lines.join('\n');
}

async function main() {
  const rollbackLines = await rollback();
  const tagged = await generateProposals();
  const entries = await gateAndApprove(tagged);
  const report = buildReport(rollbackLines, entries);

  // Local visibility only (captured in this run's own .log file) — NOT what gets delivered
  // to Telegram. See the file header for why: the skill has no telegram_output, precisely so
  // this and every other console.log/log() call in this process's dependency tree never gets
  // auto-forwarded as the "report."
  console.log(report);

  const result = await notifyUser('Self-Improvement Loop — Nightly Report', report, {
    topic: getReportTopic(),
    severity: 'info',
  });
  if (!result.sent) {
    console.error(`[self-improver] Report notification was not sent (suppressed=${result.suppressed}) — see local log above for the report content.`);
  }
}

// Guard so importing this module (e.g. from a test file, to unit-test buildReport/ReportEntry)
// doesn't actually run the whole nightly loop as a side effect of the import — only run when
// this file is executed directly, as `node dist/src/self-improver.js` (what the skill's cmd does).
if (require.main === module) {
  main().catch((err) => {
    console.error(`[self-improver] Fatal error: ${err?.stack || err}`);
    process.exitCode = 1;
  });
}
