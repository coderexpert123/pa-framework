#!/usr/bin/env node
/**
 * Nightly self-improvement loop orchestrator. Fully autonomous since 2026-07-11 — see
 * plans/2026-07-11-autonomous-self-improver-full-autonomy.md.
 *
 * 1. Roll back any autonomous change from a prior night that's now causing elevated failures.
 * 2. Sweep stale pending drafts (proposed_at >14 days ago) — reject them so the same idea can
 *    be re-proposed fresh rather than accumulating forever (Phase D thrash control).
 * 3. Analyze the last N days of conversations, skill failures, and explicit user feedback for
 *    improvement proposals. Before persisting each as a pending draft: skip (don't even save)
 *    a fix proposal whose target already has a pending draft, or was changed within the last
 *    3 days — one change at a time per skill keeps rollback attribution and evals clean.
 * 4. Gate each surviving proposal: the ONLY hard block is the self-improver protecting itself
 *    (isProtected). Everything else is dry-run validated and, if it passes, autonomously
 *    approved/applied — critical-skill / declares-secrets are risk *flags* recorded on the
 *    change, not gates. A cmd-based fix target is auto-rejected (prompt fixes are no-ops for
 *    it). Anything that fails validation stays pending, not deployed.
 * 5. Send a clean Markdown report directly via notifyUser() to the self-improvement-loop
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
import { saveDraft, markDraftMeta, approveDraft, loadDraft, listDrafts } from './drafts.js';
import { skillsDir, draftsDir } from './paths.js';
import { isProtected, isCriticalChange, hasRealSideEffects, isCmdBasedTarget, validateNewSkill, validateSkillFix, applyFix } from './validator.js';
import { loadSkill } from './skills.js';
import { appendAuditRecord, readAuditRecords, skillRunStats, toAuditBaseline, unifiedDiff } from './lib/improvement-audit.js';
import type { AuditValidation } from './lib/improvement-audit.js';
import { notifyUser, getPaAlertsChatId, getPaAlertsThreadId } from './lib/notify.js';
import { rm, copyFile } from 'fs/promises';
import { join } from 'path';
import type { DraftProposal, DraftMeta } from './types.js';

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

// Thrash control (Phase D, 2026-07-11): a fix proposal for a target that already has a
// pending draft, or that was changed within the cooldown window, is skipped entirely rather
// than piling up a second competing draft — one change at a time per skill keeps rollback
// attribution and evals clean. A pending draft older than the staleness window is reaped so
// the same idea can be re-proposed fresh instead of accumulating forever.
const COOLDOWN_DAYS = 3;
const STALE_DRAFT_DAYS = 14;

/** True if any PENDING draft already targets `targetSkill` — used to skip saving a
 * competing fix proposal for the same target rather than letting duplicates pile up. */
export async function hasPendingDraftForTarget(targetSkill: string): Promise<boolean> {
  const pending = await listDrafts('pending');
  return pending.some((d) => d.meta.target_skill === targetSkill);
}

/** True if the audit trail shows an 'applied-fix' for `targetSkill` within the last
 * `cooldownDays` days — used to skip proposing another fix for the same skill so soon. */
export async function wasRecentlyChanged(targetSkill: string, cooldownDays: number = COOLDOWN_DAYS): Promise<boolean> {
  const records = await readAuditRecords();
  const cutoff = Date.now() - cooldownDays * 24 * 60 * 60 * 1000;
  return records.some((r) => r.target_skill === targetSkill && r.action === 'applied-fix' && new Date(r.ts).getTime() >= cutoff);
}

/** Marks every PENDING draft older than `staleDays` as 'rejected_stale' (audit-logged) so it
 * stops accumulating forever — the underlying pattern, if still real, gets re-proposed fresh
 * by the next analysis run. Returns the count reaped. */
export async function sweepStaleDrafts(staleDays: number = STALE_DRAFT_DAYS): Promise<number> {
  const pending = await listDrafts('pending');
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  let count = 0;

  for (const { skill, meta } of pending) {
    if (new Date(meta.proposed_at).getTime() >= cutoff) continue;

    await markDraftMeta(skill.name, { status: 'rejected_stale' });
    await appendAuditRecord({
      ts: new Date().toISOString(),
      draft: skill.name,
      source_type: meta.source_type,
      target_skill: meta.target_skill,
      action: 'rejected_stale',
      risk_flags: meta.risk_flags ?? [],
      reason: meta.reason,
    });
    count++;
  }

  return count;
}

// Full-autonomy regime (2026-07-11): critical/secrets used to be BLOCKING gates
// ('manual-review-critical' / 'manual-review-side-effects') that routed a proposal to a
// human instead of applying it. They're now risk *flags* recorded alongside an applied
// change (see ReportEntry.riskFlags) — the only outcome that still means "nothing happened"
// for gating reasons is 'blocked-protected' (the self-improver self-guard, see
// validator.ts's isProtected()). 'manual-review-validation-failed' is renamed to
// 'validation-failed-pending' since there's no human review step to route to anymore — a
// failed validation just leaves the draft pending, where the staleness sweep (Phase D)
// eventually reaps it if nothing changes. 'auto-rejected-cmd-target', 'skipped-cooldown',
// and 'skipped-duplicate-pending' are new outcomes wired up by later phases of the
// 2026-07-11 full-autonomy plan (validation redesign + thrash control).
export interface ReportEntry {
  name: string;
  sourceType: 'conversation' | 'failure' | 'feedback';
  outcome: 'applied-fix' | 'approved-new-skill' | 'validation-failed-pending' | 'auto-rejected-cmd-target' | 'skipped-cooldown' | 'skipped-duplicate-pending' | 'blocked-protected';
  reason: string;        // the proposal's own stated reason — what pattern triggered it, in plain language
  targetSkill?: string;  // for fix/reinforce proposals: which existing skill this touches or would touch
  detail?: string;
  riskFlags?: string[];  // 'critical-skill' | 'declares-secrets' — informational only, never blocks
}

export async function rollback(): Promise<string[]> {
  const flags = await checkForRollbacks();
  const lines: string[] = [];

  for (const flag of flags) {
    try {
      // Load the draft's own meta BEFORE markDraftMeta below overwrites its status — gives
      // the audit record the original source_type/risk_flags for eval context. Best-effort:
      // a missing/corrupt draft meta just means the audit record omits those fields.
      let meta: DraftMeta | null = null;
      try {
        ({ meta } = await loadDraft(flag.draftName));
      } catch { /* best-effort */ }

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

      await appendAuditRecord({
        ts: new Date().toISOString(),
        draft: flag.draftName,
        source_type: meta?.source_type ?? 'failure',
        target_skill: flag.skillName,
        action: 'rolled-back',
        risk_flags: meta?.risk_flags ?? [],
        reason: `Elevated failure rate since ${flag.kind === 'restore' ? 'the fix was applied' : 'it was approved'} — auto-rolled-back.`,
        baseline: toAuditBaseline(await skillRunStats(flag.skillName, ANALYSIS_DAYS)),
      });
    } catch (err: any) {
      lines.push(`- Rollback FAILED for \`${flag.skillName}\` (${flag.kind}): ${err.message}`);
    }
  }

  return lines;
}

interface GeneratedProposals {
  toGate: Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback' }>;
  skipped: ReportEntry[]; // thrash-control skips (Phase D) — never even saved as a draft
}

async function generateProposals(): Promise<GeneratedProposals> {
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

  const toGate: GeneratedProposals['toGate'] = [];
  const skipped: ReportEntry[] = [];

  for (const { proposal, sourceType } of tagged) {
    const base = { name: proposal.name, sourceType, reason: proposal.reason, targetSkill: proposal.target_skill };

    // Thrash control (Phase D) only applies to fix/reinforce proposals — a brand-new skill
    // proposal (no target_skill) has nothing to collide or cool down against.
    if (proposal.target_skill) {
      if (await hasPendingDraftForTarget(proposal.target_skill)) {
        skipped.push({ ...base, outcome: 'skipped-duplicate-pending' });
        continue; // never saved — a second competing draft for the same target helps no one
      }
      if (await wasRecentlyChanged(proposal.target_skill)) {
        skipped.push({ ...base, outcome: 'skipped-cooldown' });
        continue;
      }
    }

    await saveDraft(proposal, sourceType);
    toGate.push({ proposal, sourceType });
  }

  return { toGate, skipped };
}

// Injectable so gateAndApprove is unit-testable without spawning real LLM workers (the
// default validate*/apply/approve implementations all do real I/O or real worker dispatch)
// — matches the runner-injection pattern already used throughout validator.ts/analyzer.ts.
export interface GateDeps {
  validateNewSkillFn?: typeof validateNewSkill;
  validateSkillFixFn?: typeof validateSkillFix;
  applyFixFn?: typeof applyFix;
  approveDraftFn?: typeof approveDraft;
}

export async function gateAndApprove(
  tagged: Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback' }>,
  deps: GateDeps = {}
): Promise<ReportEntry[]> {
  const {
    validateNewSkillFn = validateNewSkill,
    validateSkillFixFn = validateSkillFix,
    applyFixFn = applyFix,
    approveDraftFn = approveDraft,
  } = deps;

  const entries: ReportEntry[] = [];

  for (const { proposal, sourceType } of tagged) {
    const base = { name: proposal.name, sourceType, reason: proposal.reason, targetSkill: proposal.target_skill };

    // The ONLY remaining hard block — self-guard against the loop ever touching itself.
    if (isProtected(proposal)) {
      entries.push({ ...base, outcome: 'blocked-protected' });
      continue;
    }

    // critical-skill / declares-secrets are now risk FLAGS, not gates — computed and
    // recorded alongside whatever gateAndApprove decides to do with the proposal below.
    const riskFlags: string[] = [];
    if (await isCriticalChange(proposal)) riskFlags.push('critical-skill');
    if (await hasRealSideEffects(proposal)) riskFlags.push('declares-secrets');

    if (!proposal.target_skill) {
      let detail: AuditValidation = {};
      const valid = await validateNewSkillFn(proposal, undefined, (d) => { detail = d; });
      if (valid) {
        await approveDraftFn(proposal.name, { approved_autonomously: true, risk_flags: riskFlags });
        entries.push({ ...base, outcome: 'approved-new-skill', riskFlags });
        await appendAuditRecord({
          ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
          action: 'approved-new-skill', risk_flags: riskFlags, reason: proposal.reason,
          validation: detail, diff: proposal.prompt.slice(0, 4000),
        });
      } else {
        entries.push({ ...base, outcome: 'validation-failed-pending', riskFlags });
        await appendAuditRecord({
          ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
          action: 'validation-failed', risk_flags: riskFlags, reason: proposal.reason,
          validation: detail, diff: proposal.prompt.slice(0, 4000),
        });
      }
    } else if (await isCmdBasedTarget(proposal.target_skill)) {
      // Prompt fixes are no-ops for a cmd-based skill (run.ts executes the cmd; the prompt is
      // documentation) — auto-reject immediately rather than leave it pending forever.
      await markDraftMeta(proposal.name, { status: 'rejected_auto' });
      entries.push({ ...base, outcome: 'auto-rejected-cmd-target', riskFlags });
      await appendAuditRecord({
        ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
        target_skill: proposal.target_skill, action: 'rejected_auto', risk_flags: riskFlags,
        reason: proposal.reason,
      });
    } else {
      // Capture the OLD prompt BEFORE applyFixFn overwrites target_skill's skill.md, so the
      // audit diff shows what actually changed — after applyFixFn, loadSkill would return
      // the NEW prompt instead.
      let oldPrompt = '';
      try { oldPrompt = (await loadSkill(proposal.target_skill)).prompt; } catch { /* best-effort */ }

      let detail: AuditValidation = {};
      const valid = await validateSkillFixFn(proposal, undefined, undefined, (d) => { detail = d; });
      if (valid) {
        await applyFixFn(proposal, riskFlags);
        entries.push({
          ...base,
          outcome: 'applied-fix',
          riskFlags,
          detail: `overwrote \`${proposal.target_skill}\` (backup: \`${proposal.name}/target-backup.skill.md\`)`,
        });
        await appendAuditRecord({
          ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
          target_skill: proposal.target_skill, action: 'applied-fix', risk_flags: riskFlags,
          reason: proposal.reason, validation: detail, diff: unifiedDiff(oldPrompt, proposal.prompt),
          backup_path: join(draftsDir(), proposal.name, 'target-backup.skill.md'),
          baseline: toAuditBaseline(await skillRunStats(proposal.target_skill, ANALYSIS_DAYS)),
        });
      } else {
        entries.push({ ...base, outcome: 'validation-failed-pending', riskFlags });
        await appendAuditRecord({
          ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
          target_skill: proposal.target_skill, action: 'validation-failed', risk_flags: riskFlags,
          reason: proposal.reason, validation: detail, diff: unifiedDiff(oldPrompt, proposal.prompt),
        });
      }
    }
  }

  return entries;
}

function riskFlagSuffix(e: ReportEntry): string {
  return e.riskFlags && e.riskFlags.length > 0 ? ` [risk: ${e.riskFlags.join(', ')}]` : '';
}

export function buildReport(rollbackLines: string[], entries: ReportEntry[], staleCount: number = 0): string {
  const applied = entries.filter((e) => e.outcome === 'approved-new-skill' || e.outcome === 'applied-fix');
  const pending = entries.filter((e) => e.outcome === 'validation-failed-pending');
  const autoRejected = entries.filter((e) => e.outcome === 'auto-rejected-cmd-target');
  const skipped = entries.filter((e) => e.outcome === 'skipped-duplicate-pending' || e.outcome === 'skipped-cooldown');
  const blocked = entries.filter((e) => e.outcome === 'blocked-protected');

  const lines: string[] = [];
  lines.push(`Analyzed the last ${ANALYSIS_DAYS} days. ${entries.length} proposal(s) generated.`);
  lines.push('');

  if (rollbackLines.length > 0) {
    lines.push(`*Rollbacks (${rollbackLines.length})*`);
    lines.push(...rollbackLines);
    lines.push('');
  }

  if (staleCount > 0) {
    lines.push(`*Stale drafts reaped (${staleCount})* — pending >${STALE_DRAFT_DAYS} days; re-propose if still real.`);
    lines.push('');
  }

  if (applied.length > 0) {
    lines.push(`*Autonomously applied (${applied.length})*`);
    for (const e of applied) {
      const what = e.outcome === 'approved-new-skill' ? 'new skill' : `fix to \`${e.targetSkill}\``;
      lines.push(`- \`${e.name}\` (${e.sourceType}) — ${what}${riskFlagSuffix(e)}${e.detail ? `: ${e.detail}` : ''}`);
      lines.push(`  ↳ ${e.reason}`);
      lines.push('  ↳ audit: self-improver-audit.jsonl');
    }
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push(`*Pending — failed autonomous validation (${pending.length})* — run \`pa drafts\` to inspect`);
    for (const e of pending) {
      const what = e.targetSkill ? `proposed fix for \`${e.targetSkill}\`` : 'proposed new skill';
      lines.push(`- \`${e.name}\` (${e.sourceType}) — ${what}${riskFlagSuffix(e)}`);
      lines.push(`  ↳ ${e.reason}`);
    }
    lines.push('');
  }

  if (autoRejected.length > 0) {
    lines.push(`*Auto-rejected — cmd-based target (${autoRejected.length})*`);
    for (const e of autoRejected) {
      lines.push(`- \`${e.name}\` (${e.sourceType}) — targets \`${e.targetSkill}\`, a cmd-based skill (prompt fixes are no-ops for it)`);
      lines.push(`  ↳ ${e.reason}`);
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push(`*Skipped (${skipped.length})*`);
    for (const e of skipped) {
      const why = e.outcome === 'skipped-duplicate-pending'
        ? `duplicate pending draft already exists for \`${e.targetSkill}\``
        : `\`${e.targetSkill}\` was changed within the last 3 days, observing`;
      lines.push(`- \`${e.name}\` — ${why}`);
    }
    lines.push('');
  }

  if (blocked.length > 0) {
    lines.push(`*Blocked — protected skill (${blocked.length})*`);
    for (const e of blocked) {
      lines.push(`- \`${e.name}\` (${e.sourceType}) — targets the protected \`${e.targetSkill ?? e.name}\``);
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
  const staleCount = await sweepStaleDrafts();
  const { toGate, skipped } = await generateProposals();
  const gateEntries = await gateAndApprove(toGate);
  const entries = [...skipped, ...gateEntries];
  const report = buildReport(rollbackLines, entries, staleCount);

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
