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
import { analyzeFailurePatterns, checkForRollbacks, readRecentFailures } from './failure-analyzer.js';
import { attemptCodeFix, CHURN_PATHSPEC_ARGS, isChurnPath, parsePorcelainPaths, popChurn, stashChurn } from './code-fixer.js';
import { analyzeFeedbackPatterns } from './feedback-analyzer.js';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { saveDraft, markDraftMeta, approveDraft, loadDraft, listDrafts } from './drafts.js';
import { skillsDir, draftsDir } from './paths.js';
import { isProtected, isCriticalChange, hasRealSideEffects, isCmdBasedTarget, validateNewSkill, validateSkillFix, applyFix } from './validator.js';
import { loadSkill } from './skills.js';
import { appendAuditRecord, readAuditRecords, skillRunStats, toAuditBaseline, unifiedDiff } from './lib/improvement-audit.js';
import type { AuditValidation } from './lib/improvement-audit.js';
import { notifyUser, resolveNotifyTopic } from './lib/notify.js';
import { rm, copyFile } from 'fs/promises';
import { join } from 'path';
import type { DraftProposal, DraftMeta } from './types.js';

const SELF_NAME = 'self-improver';
// Env-driven so the framework is portable (matches lib/notify.ts's own
// PA_ALERTS_CHAT_ID pattern) — falls back to the general alerts topic when
// no dedicated self-improvement-loop topic is configured. Resolved lazily
// (at use, not module-load) because CLI invocations may load secrets after
// this module is first imported.
//
// DO NOT REGRESS to `process.env.PA_SELF_IMPROVER_THREAD_ID || ...`: this skill
// runs as a `cmd:` skill with NO `secrets:` frontmatter, so commands/run.ts
// hands its child process none of ~/.pa/secrets.env — and that is the only
// place PA_SELF_IMPROVER_THREAD_ID exists. The env-only read resolved thread 0,
// and because notify.ts's route repair only covers an empty CHAT id, the
// nightly report landed in pa-alerts instead of the self-improvement-loop
// topic. resolveNotifyTopic() applies process.env → secrets.env → pa-alerts
// default to BOTH ids.
export async function getReportTopic(): Promise<{ chat_id: string; thread_id: number }> {
  return resolveNotifyTopic({
    chatKey: 'PA_SELF_IMPROVER_CHAT_ID',
    threadKey: 'PA_SELF_IMPROVER_THREAD_ID',
  });
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
  outcome: 'applied-fix' | 'approved-new-skill' | 'validation-failed-pending' | 'auto-rejected-cmd-target' | 'skipped-cooldown' | 'skipped-duplicate-pending' | 'blocked-protected'
    | 'applied-code-fix' | 'code-fix-reverted' | `code-fix-skipped-${string}`;
  reason: string;        // the proposal's own stated reason — what pattern triggered it, in plain language
  targetSkill?: string;  // for fix/reinforce proposals: which existing skill this touches or would touch
  detail?: string;
  riskFlags?: string[];  // 'critical-skill' | 'declares-secrets' — informational only, never blocks
}

// Injectable for tests — the git-revert kind shells out to real git otherwise.
export interface RollbackDeps {
  checkForRollbacksFn?: typeof checkForRollbacks;
  execFn?: (command: string, options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
}

type RollbackExec = NonNullable<RollbackDeps['execFn']>;

const execAsync = promisify(execCb);
const defaultRollbackExec: RollbackExec = (command, options) => execAsync(command, { cwd: options?.cwd });

export interface GitRevertResult {
  revertCommitHash: string;
  /** Set when the churn stash could not be popped — the data is still IN the stash, not lost. */
  churnRestoreError?: string;
}

/**
 * `git revert`s a prior applied-code-fix commit without tripping over — or destroying — the
 * nightly pa/data/profile* churn that learn_agent/oracle writes.
 *
 * The bare `git revert --no-edit HASH` this replaces aborted every time that churn was
 * present ("Your local changes to the following files would be overwritten by merge:
 * pa/data/profile-history-archive.jsonl, pa/data/profile.json"), leaving the CONDEMNED fix
 * live: ~/.pa/self-improver-audit.jsonl records action 'rollback-failed' for commit 7b82c88
 * on both 2026-07-13 and 2026-07-16, and 7b82c88 is still an ancestor of HEAD. The other
 * half of the fix lives in code-fixer.ts (fix commits no longer CONTAIN those data files).
 *
 * Shape of the safe sequence — never `git checkout`/`git clean` the profile files, never
 * discard them:
 *   1. refuse outright if there is human WIP in the tree (mirrors code-fixer's F4, and is
 *      what makes the failure-path `git reset --hard HEAD` below safe);
 *   2. stash ONLY the churn paths;
 *   3. `git revert -n` (staged, uncommitted) so the churn paths can be dropped from the
 *      revert before it becomes a commit — a revert commit carrying pa/data/profile* would
 *      itself be un-revertable, reproducing the original bug one generation down;
 *   4. commit, then pop the churn stash back on top.
 * A crash anywhere between 2 and 4 leaves profile.json at its last COMMITTED content — valid
 * JSON, never truncated — with the newer content recoverable from `git stash list`.
 */
export async function gitRevertPreservingChurn(
  commitHash: string,
  execFn: RollbackExec
): Promise<GitRevertResult> {
  const { stdout: statusOut } = await execFn('git status --porcelain');
  const humanWip = parsePorcelainPaths(statusOut).filter((p) => !isChurnPath(p));
  if (humanWip.length > 0) {
    throw new Error(
      `working tree has ${humanWip.length} uncommitted change(s) (${humanWip.slice(0, 5).join(', ')}) — refusing to revert ${commitHash}; the condemned fix is still live.`
    );
  }

  const stashed = await stashChurn(execFn, `pa-self-improver-revert-${commitHash}`);

  let revertErr: unknown;
  try {
    await execFn(`git revert -n ${commitHash}`);
    // Drop the churn paths from the staged revert. A pathspec that matches nothing (a repo
    // without these files) is not a reason to abort an otherwise-good revert.
    await execFn(`git checkout HEAD -- ${CHURN_PATHSPEC_ARGS}`).catch(() => {});
    // `-c core.editor=true`: `git revert -n` leaves the revert message in .git/MERGE_MSG for
    // --no-edit to pick up, but a missing MERGE_MSG would otherwise launch $EDITOR and hang
    // this unattended nightly process forever. Failing fast beats hanging.
    await execFn('git -c core.editor=true commit --no-edit');
    // Clear any lingering sequencer state so the next `git status` doesn't report
    // "revert in progress". An error here just means there was none.
    await execFn('git revert --quit').catch(() => {});
  } catch (err) {
    revertErr = err;
    // Leave nothing half-applied. Safe for the churn files: they are in the stash and get
    // restored immediately below, and step 1 proved there is no human WIP to destroy.
    await execFn('git revert --quit').catch(() => {});
    await execFn('git reset --hard HEAD').catch(() => {});
  }

  const churnRestoreError = stashed ? await popChurn(execFn) : undefined;

  if (revertErr) {
    const e = revertErr instanceof Error ? revertErr : new Error(String(revertErr));
    if (churnRestoreError) e.message = `${e.message} | ${churnRestoreError}`;
    throw e;
  }

  const { stdout } = await execFn('git rev-parse HEAD');
  return { revertCommitHash: stdout.trim(), churnRestoreError };
}

export async function rollback(deps: RollbackDeps = {}): Promise<string[]> {
  const { checkForRollbacksFn = checkForRollbacks, execFn = defaultRollbackExec } = deps;
  const flags = await checkForRollbacksFn();
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
      } else if (flag.kind === 'git-revert') {
        // A prior autonomous CODE fix (applied-code-fix commit) whose target skill is now
        // failing at an elevated rate: revert the commit, push the revert (offsite
        // recoverability parity with the original fix), and warn when the reverted fix
        // touched code that needs a rebuild/restart to take effect — the fix's own audit
        // record carries files_changed, so no extra git call is needed for that.
        // The revert goes through gitRevertPreservingChurn (2026-07-21) so the nightly
        // pa/data/profile* churn can neither abort it nor be destroyed by it.
        if (!flag.commitHash) {
          throw new Error('git-revert rollback flag carries no commit hash — nothing to revert.');
        }
        const { revertCommitHash, churnRestoreError } = await gitRevertPreservingChurn(flag.commitHash, execFn);
        await execFn('git push origin master');
        await markDraftMeta(flag.draftName, { status: 'rejected_post_rollback' }).catch(() => {});

        const originalFix = (await readAuditRecords()).find(
          (r) => r.action === 'applied-code-fix' && r.commit_hash === flag.commitHash);
        const touched = originalFix?.files_changed ?? [];
        const needsRebuild = touched.some((f: string) =>
          f.startsWith('pa/src') || f.startsWith('projects/telegram-bot/src'));

        lines.push(`- **Reverted** code fix \`${flag.commitHash}\` targeting \`${flag.skillName}\` (revert commit \`${revertCommitHash}\`) — elevated failure rate since the fix was applied.${needsRebuild ? ' ⚠️ The reverted fix touched framework/bot source — a rebuild and bot restart may be required for the revert to take effect.' : ''}${churnRestoreError ? ` ⚠️ ${churnRestoreError}` : ''}`);

        await appendAuditRecord({
          ts: new Date().toISOString(),
          draft: flag.draftName,
          source_type: meta?.source_type ?? 'failure',
          target_skill: flag.skillName,
          action: 'rolled-back',
          risk_flags: meta?.risk_flags ?? [],
          reason: 'Elevated failure rate since the code fix was applied — git-reverted.',
          commit_hash: flag.commitHash,
          revert_commit_hash: revertCommitHash,
          baseline: toAuditBaseline(await skillRunStats(flag.skillName, ANALYSIS_DAYS)),
        });
        continue; // audit written above with the revert-specific fields — skip the shared one
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
      if (flag.kind === 'git-revert') {
        // A failed git revert (e.g. conflict) leaves the bad fix LIVE — make that queryable,
        // not just a report line. Best-effort: audit-append must never mask the original error.
        await appendAuditRecord({
          ts: new Date().toISOString(),
          draft: flag.draftName,
          source_type: 'failure',
          target_skill: flag.skillName,
          action: 'rollback-failed',
          risk_flags: [],
          reason: `git revert ${flag.commitHash} failed: ${err.message}`.slice(0, 500),
          commit_hash: flag.commitHash,
        }).catch(() => {});
      }
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
  attemptCodeFixFn?: typeof attemptCodeFix;
  readRecentFailuresFn?: typeof readRecentFailures;
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
    attemptCodeFixFn = attemptCodeFix,
    readRecentFailuresFn = readRecentFailures,
  } = deps;

  const entries: ReportEntry[] = [];
  // F5: one code-fix attempt per nightly run, globally — bounds blast radius and keeps
  // rollback attribution + evals to a single variable per night.
  let codeFixAttempted = false;

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
      // A cmd-based skill's real behavior lives in its script, not its prompt — so instead of
      // parking a no-op prompt fix (the pre-2026-07-11 'auto-rejected-cmd-target' behavior),
      // route the failure evidence to the autonomous code-fixer. The prompt-fix DRAFT itself
      // is never deployed either way: it's marked rejected_auto and serves as the trigger
      // record; the actual fix (if any) lands as a git commit in the target project.
      // attemptCodeFix appends its own audit records for every outcome (applied, reverted,
      // every skip reason) — the rejected_auto record below covers only the draft's fate.
      await markDraftMeta(proposal.name, { status: 'rejected_auto' });
      await appendAuditRecord({
        ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
        target_skill: proposal.target_skill, action: 'rejected_auto', risk_flags: riskFlags,
        reason: proposal.reason,
      });

      if (codeFixAttempted) {
        entries.push({ ...base, outcome: 'code-fix-skipped-limit-reached', riskFlags });
        continue;
      }
      codeFixAttempted = true;

      const evidence = (await readRecentFailuresFn(ANALYSIS_DAYS))
        .filter((f) => f.skillName === proposal.target_skill);
      const result = await attemptCodeFixFn(proposal, evidence);
      entries.push({ ...base, outcome: result.outcome, riskFlags, detail: result.reason });
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
  const applied = entries.filter((e) => e.outcome === 'approved-new-skill' || e.outcome === 'applied-fix' || e.outcome === 'applied-code-fix');
  const pending = entries.filter((e) => e.outcome === 'validation-failed-pending');
  const autoRejected = entries.filter((e) => e.outcome === 'auto-rejected-cmd-target');
  const skipped = entries.filter((e) => e.outcome === 'skipped-duplicate-pending' || e.outcome === 'skipped-cooldown');
  const blocked = entries.filter((e) => e.outcome === 'blocked-protected');
  const codeFixReverted = entries.filter((e) => e.outcome === 'code-fix-reverted');
  const codeFixSkipped = entries.filter((e) => e.outcome.startsWith('code-fix-skipped-'));

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
      const what = e.outcome === 'approved-new-skill' ? 'new skill'
        : e.outcome === 'applied-code-fix' ? `code fix to \`${e.targetSkill}\``
        : `fix to \`${e.targetSkill}\``;
      lines.push(`- \`${e.name}\` (${e.sourceType}) — ${what}${riskFlagSuffix(e)}${e.detail ? `: ${e.detail}` : ''}`);
      lines.push(`  ↳ ${e.reason}`);
      lines.push('  ↳ audit: self-improver-audit.jsonl');
    }
    lines.push('');
  }

  if (codeFixReverted.length > 0) {
    lines.push(`*Code fixes reverted (${codeFixReverted.length})* — attempted, failed verification, restored`);
    for (const e of codeFixReverted) {
      lines.push(`- \`${e.name}\` — targeted \`${e.targetSkill}\`${riskFlagSuffix(e)}${e.detail ? `: ${e.detail}` : ''}`);
      lines.push(`  ↳ ${e.reason}`);
      lines.push('  ↳ audit: self-improver-audit.jsonl');
    }
    lines.push('');
  }

  if (codeFixSkipped.length > 0) {
    lines.push(`*Code fixes skipped (${codeFixSkipped.length})*`);
    for (const e of codeFixSkipped) {
      // outcome suffix like 'dirty-worktree' / 'limit-reached' → human words
      const why = e.outcome.slice('code-fix-skipped-'.length).replace(/-/g, ' ');
      lines.push(`- \`${e.name}\` — ${why}${e.detail ? `: ${e.detail}` : ''}`);
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
    topic: await getReportTopic(),
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
