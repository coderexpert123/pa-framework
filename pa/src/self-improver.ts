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
import { randomUUID } from 'crypto';
import { analyzeConversationPatterns } from './analyzer.js';
import { analyzeFailurePatterns, checkForRollbacks, readRecentFailures, censusProposals } from './failure-analyzer.js';
import type { FailureRecord } from './failure-analyzer.js';
import { attemptCodeFix, CHURN_PATHSPEC_ARGS, isChurnPath, parsePorcelainPaths, popChurn, stashChurn, GIT_WORKFLOW_RESOURCE, GIT_LOCK_WAIT_MS } from './code-fixer.js';
import type { BlackboardLockClient } from './code-fixer.js';
import { checkGitWorkflowAllowed } from './lib/git-guard.js';
import type { GitGuardResult } from './lib/git-guard.js';
import { analyzeFeedbackPatterns } from './feedback-analyzer.js';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { saveDraft, markDraftMeta, approveDraft, loadDraft, listDrafts, cleanRejected, updateDraftPrompt } from './drafts.js';
import { skillsDir, draftsDir } from './paths.js';
import { isProtected, isCriticalChange, hasRealSideEffects, isCmdBasedTarget, validateNewSkill, validateSkillFix, applyFix, regenerateProposal } from './validator.js';
import { loadSkill, listSkills } from './skills.js';
import { blackboard } from './blackboard.js';
import { exclusiveLockKey } from './commands/run.js';
import { appendAuditRecord, readAuditRecords, skillRunStats, toAuditBaseline, unifiedDiff } from './lib/improvement-audit.js';
import type { AuditValidation } from './lib/improvement-audit.js';
import { runEvalGate, formatEvalDetail } from './lib/eval-gate.js';
import { notifyUser, resolveNotifyTopic } from './lib/notify.js';
import { buildHITLKeyboard, buildDraftKeyboard } from './lib/hitl-keyboard.js';
import { createPostmortemStub } from './lib/postmortem.js';
import type { PostmortemInput, PostmortemMetadata } from './lib/postmortem.js';
import { buildAlertCensus } from './lib/alert-census.js';
import type { AlertCensus } from './lib/alert-census.js';
import { jobsForHost } from './lib/maintenance/registry.js';
import { repoRootFromModule } from './lib/git-root.js';
import { rm, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { DraftProposal, DraftMeta } from './types.js';

// git-workflow lock (2026-08-05) — rollback()'s git-revert path shells out to git directly
// (git status/revert/reset --hard/push), entirely outside the skill-frontmatter
// exclusive_resource mechanism. Same lock as code-fixer.ts's attemptCodeFix, acquired here
// independently (not held across the whole nightly main()) — see plans/federated-booping-hammock.md.
const ROLLBACK_LOCK_AGENT = 'self-improver-rollback';

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

/**
 * Generates a URL-safe slug from a rollback/rollback-failed event.
 * Converts to kebab-case and limits length to avoid filesystem issues.
 */
function generatePostmortemSlug(action: string, skillName: string, commitHash?: string): string {
  const base = `${action}-${skillName}`;
  const suffix = commitHash ? `-${commitHash.slice(0, 8)}` : '';
  // Limit to reasonable length and ensure filesystem-safe
  return `${base}${suffix}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60);
}

/**
 * Creates action items from the audit record's skill+reason.
 * Each action item is a concise checklist item for follow-up.
 */
function generateActionItems(skillName: string, reason: string, commitHash?: string): string[] {
  const items: string[] = [
    `Investigate root cause of ${skillName} rollback`,
  ];
  if (commitHash) {
    items.push(`Review code changes in commit ${commitHash}`);
  }
  items.push(`Update this postmortem with root cause analysis`);
  items.push(`Close resolved action items (uncheck when complete)`);
  return items;
}

/**
 * Extracts timeline refs from the audit record and context.
 * For rollbacks, includes the original fix commit and the revert commit.
 */
function extractTimelineRefs(commitHash?: string, revertCommitHash?: string): string[] {
  const refs: string[] = [];
  // Future: could look up ref-IDs from the audit trail or recent logs
  if (revertCommitHash) {
    refs.push(`Revert commit: ${revertCommitHash}`);
  }
  return refs;
}

/**
 * Creates a postmortem stub and updates INDEX.md after a rollback or rollback-failed.
 * Called immediately after appendAuditRecord in the rollback path.
 *
 * This is deterministic and does not use an LLM — it's pure string templating.
 */
async function maybeCreatePostmortem(
  action: 'rolled-back' | 'rollback-failed',
  skillName: string,
  reason: string,
  commitHash?: string,
  revertCommitHash?: string,
  // Test-only (AI-176): forwarded from RollbackDeps.postmortemRepoRoot so tests
  // driving the real rollback path never write into the live repo tree.
  // Production always omits this — createPostmortemStub derives the true repo
  // root itself, independent of process.cwd().
  repoRoot?: string
): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const slug = generatePostmortemSlug(action, skillName, commitHash);
    const title = `${action === 'rolled-back' ? 'Rollback' : 'Failed Rollback'}: ${skillName}`;

    const timelineRefs = extractTimelineRefs(commitHash, revertCommitHash);
    const actionItems = generateActionItems(skillName, reason, commitHash);

    const input: PostmortemInput = {
      date: today,
      slug,
      title,
      timelineRefs,
      actionItems,
    };

    const meta: PostmortemMetadata = {
      created: new Date().toISOString(),
      sourceAction: action,
      sourceSkill: skillName,
      sourceCommit: commitHash,
    };

    const filepath = await createPostmortemStub(input, meta, { repoRoot });

    // Log to console so it appears in the self-improver run log
    console.log(`[self-improver] Postmortem stub created: ${filepath}`);
  } catch (err) {
    // Postmortem creation failure must not break the rollback flow
    console.error(`[self-improver] Failed to create postmortem stub: ${err}`);
  }
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
  /** The `ts` of the audit record THIS entry produced (pa/src/lib/improvement-audit.js
   *  AuditRecord.ts) — set only for outcomes that wrote one with a matching, known ts
   *  (WP-P1, 2026-08-24). Absent, never guessed: `buildHITLKeyboard`'s `pm:<ts>:<action>`
   *  callback must key on the record that actually exists, or a press just answers
   *  "Audit record not found". */
  ts?: string;
}

// Injectable for tests — the git-revert kind shells out to real git otherwise.
export interface RollbackDeps {
  checkForRollbacksFn?: typeof checkForRollbacks;
  execFn?: (command: string, options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;
  blackboardFn?: BlackboardLockClient;
  notifyUserFn?: typeof notifyUser;
  /** Test-only: overrides the git-optional gate for the git-revert branch (2026-08-31 WP-B). */
  gitGuardFn?: () => Promise<GitGuardResult>;
  /** Test-only (AI-176): overrides createPostmortemStub's write root. Production
   *  always omits this — postmortem.ts resolves the true repo root itself via
   *  repoRootFromModule, independent of process.cwd(), so a test that drives
   *  this real (unmocked) rollback path must pass its own isolated fixture
   *  root here or it writes real postmortem stubs into the live repo tree. */
  postmortemRepoRoot?: string;
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
 * The bare `git revert --no-edit HASH` this replaced aborted every time that churn was
 * present ("Your local changes to the following files would be overwritten by merge:
 * pa/data/profile-history-archive.jsonl, pa/data/profile.json"), leaving the CONDEMNED fix
 * live: ~/.pa/self-improver-audit.jsonl records action 'rollback-failed' for commit 7b82c88
 * on both 2026-07-13 and 2026-07-16, and 7b82c88 is still an ancestor of HEAD. The other
 * half of the fix lives in code-fixer.ts (fix commits no longer CONTAIN those data files).
 *
 * Shape of the safe sequence — never `git checkout`/`git clean` the profile files, never
 * discard them:
 *   1. compute the condemned commit's touched files; refuse only if non-churn WIP overlaps
 *      those files (fallback to refusing on ANY non-churn WIP if diff-tree fails — fail
 *      closed);
 *   2. stash ONLY the churn paths;
 *   3. `git revert -n` (staged, uncommitted) so the churn paths can be dropped from the
 *      revert before it becomes a commit — a revert commit carrying pa/data/profile* would
 *      itself be un-revertable, reproducing the original bug one generation down;
 *   4. commit, then pop the churn stash back on top.
 * A crash anywhere between 2 and 4 leaves profile.json at its last COMMITTED content — valid
 * JSON, never truncated — with the newer content recoverable from `git stash list`.
 *
 * On failure (e.g. merge conflict), cleanup runs `git revert --quit` + targeted
 * `git checkout HEAD -- <condemned paths>` only — NOT a tree-wide `git reset --hard HEAD`,
 * since the tree may legitimately carry unrelated WIP now that refusal is scoped.
 */
export async function gitRevertPreservingChurn(
  commitHash: string,
  execFn: RollbackExec
): Promise<GitRevertResult> {
  // Step 1: compute condemned commit's files to scope the refusal check.
  let condemnedPaths: string[] = [];
  let diffTreeFailed = false;
  try {
    const { stdout: diffTreeOut } = await execFn(`git diff-tree --no-commit-id --name-only -r ${commitHash}`);
    condemnedPaths = diffTreeOut.trim().split('\n')
      .filter(Boolean)
      .map((p) => p.replace(/^"|"$/g, '')) // Strip surrounding quotes if present.
      .map((p) => p.replace(/\\/g, '/')); // Normalize Windows backslashes.
  } catch {
    diffTreeFailed = true;
  }

  // Conservative fallback: if diff-tree failed or returned nothing, refuse on ANY non-churn WIP.
  // This is fail-closed — the gate only gets narrower when we actually know the condemned set.
  if (condemnedPaths.length === 0) {
    const { stdout: statusOut } = await execFn('git status --porcelain');
    const humanWip = parsePorcelainPaths(statusOut).filter((p) => !isChurnPath(p));
    if (humanWip.length > 0) {
      throw new Error(
        `working tree has ${humanWip.length} uncommitted change(s) (${humanWip.slice(0, 5).join(', ')}) — refusing to revert ${commitHash}; the condemned fix is still live.`
      );
    }
  } else {
    // Narrow refusal: only refuse if non-churn WIP overlaps the condemned commit's files.
    const { stdout: statusOut } = await execFn('git status --porcelain');
    const humanWip = parsePorcelainPaths(statusOut).filter((p) => !isChurnPath(p));
    const overlapping = humanWip.filter((p) => condemnedPaths.includes(p));
    if (overlapping.length > 0) {
      throw new Error(
        `working tree has uncommitted change(s) overlapping the condemned commit (${overlapping.slice(0, 5).join(', ')}) — refusing to revert ${commitHash}; the condemned fix is still live.`
      );
    }
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
    // Scoped failure cleanup: only revert the condemned paths we know we touched, not the
    // whole tree. Safe for the churn files: they are in the stash and get restored below.
    await execFn('git revert --quit').catch(() => {});
    if (condemnedPaths.length > 0 && !diffTreeFailed) {
      await execFn(`git checkout HEAD -- ${condemnedPaths.join(' ')}`).catch(() => {});
    }
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
  const { checkForRollbacksFn = checkForRollbacks, execFn = defaultRollbackExec, blackboardFn, notifyUserFn = notifyUser, gitGuardFn = checkGitWorkflowAllowed, postmortemRepoRoot } = deps;
  const flags = await checkForRollbacksFn();
  // The overwhelming common case — checkForRollbacksFn() reads run metadata only, no git —
  // so this must never pay for or contend on a lock it doesn't need.
  if (flags.length === 0) return [];

  const bb = blackboardFn ?? blackboard;
  const lockKey = exclusiveLockKey(GIT_WORKFLOW_RESOURCE);
  // C11 (2026-08-23): contextId + pid threaded through, matching the other
  // three git-workflow-lock sites (D3/D4). No heartbeat/onLost migration
  // here — this hold is short by construction (checkForRollbacksFn() returns
  // early in the common case) and has no timer to migrate onto startLockRenewal.
  const contextId = randomUUID();
  const lockAcquired = await bb.acquireLock(lockKey, ROLLBACK_LOCK_AGENT, process.pid, GIT_LOCK_WAIT_MS, contextId);
  if (!lockAcquired) {
    // Deliberately NO appendAuditRecord here: a 'rollback-failed' record trips `pa
    // improvements`' FAILED ROLLBACKS banner, which only clears via a human `pa improvements
    // accept` — not warranted for a transient, self-healing lock wait that the next run retries.
    return [`- Rollbacks DEFERRED (${flags.length} flagged) — another skill/process is holding the git-workflow lock; will retry next run.`];
  }

  try {
    return await runRollbacks();
  } finally {
    await bb.releaseLock(lockKey, ROLLBACK_LOCK_AGENT, contextId, { pid: process.pid }).catch(() => {});
  }

  async function runRollbacks(): Promise<string[]> {
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
        // Git-optional gate (2026-08-31 WP-B): a deployment that disabled git after a fix
        // was applied cannot autonomously revert it. Throwing lands in the catch below,
        // which already writes a 'rollback-failed' audit record, a postmortem stub, and a
        // pa-alerts notification — a bad fix left LIVE must be visible, never silently kept.
        const rollbackGuard = await gitGuardFn();
        if (!rollbackGuard.allowed) {
          throw new Error(`git workflow not allowed (${rollbackGuard.reason}) — manual revert of ${flag.commitHash} required`);
        }
        const { revertCommitHash, churnRestoreError } = await gitRevertPreservingChurn(flag.commitHash, execFn);
        // Push to whatever branch HEAD actually tracks — do NOT hardcode a branch name (the
        // private repo's default branch was renamed master -> main 2026-07-23; a hardcoded
        // `master` here silently failed every git-revert rollback's push since that rename).
        const { stdout: branchRaw } = await execFn('git rev-parse --abbrev-ref HEAD');
        await execFn(`git push origin ${branchRaw.trim()}`);
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
        // WPD6: Create postmortem stub after rollback
        await maybeCreatePostmortem('rolled-back', flag.skillName, 'Elevated failure rate since the code fix was applied — git-reverted.', flag.commitHash, revertCommitHash, postmortemRepoRoot);
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
      // WPD6: Create postmortem stub after rollback
      await maybeCreatePostmortem('rolled-back', flag.skillName, `Elevated failure rate since ${flag.kind === 'restore' ? 'the fix was applied' : 'it was approved'} — auto-rolled-back.`, undefined, undefined, postmortemRepoRoot);
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

        // WPD6: Create postmortem stub after rollback-failed
        await maybeCreatePostmortem('rollback-failed', flag.skillName, `git revert ${flag.commitHash} failed: ${err.message}`.slice(0, 500), flag.commitHash, undefined, postmortemRepoRoot).catch(() => {});

        // Send pa-alerts notification (P2-19) — a bad fix is live pending manual revert
        const refId = Math.random().toString(16).slice(2, 14);
        await notifyUserFn(
          `Rollback Failed — Bad Fix Live`,
          `Skill: ${flag.skillName}\nCommit: ${flag.commitHash}\nDraft: ${flag.draftName}\n\nA failed rollback leaves the bad fix LIVE. Manual revert required.\n\n_Ref: ${refId}_`,
          { dedupKey: 'rollback-failed', severity: 'error' },
        ).catch((e) => {
          console.error(`[self-improver] Failed to send rollback-failed notification: ${e?.message}`);
        });
      }
    }
  }

  return lines;
  }
}

interface GeneratedProposals {
  toGate: Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback'; evidence?: FailureRecord[] }>;
  skipped: ReportEntry[]; // thrash-control skips (Phase D) — never even saved as a draft
}

/**
 * `census`, when provided, feeds `censusProposals` (deterministic, no LLM) into the same
 * tagged/toGate pipeline as the three LLM-driven analyzers below — thrash control
 * (hasPendingDraftForTarget / wasRecentlyChanged / saveDraft) applies to census proposals
 * unchanged (decision (g), plans/2026-08-23-alerts-wave-SPEC.md §3). Census proposals are
 * tagged sourceType 'failure' (decision (h) — they ARE failure evidence; a new sourceType
 * union member would ripple into types.ts/drafts.ts/improvement-audit.ts for no gain).
 */
async function generateProposals(census?: AlertCensus): Promise<GeneratedProposals> {
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

  const tagged: GeneratedProposals['toGate'] = [
    ...conversationProposals.map((proposal) => ({ proposal, sourceType: 'conversation' as const })),
    ...failureProposals.filter(excludesSelf).map((proposal) => ({ proposal, sourceType: 'failure' as const })),
    ...feedbackProposals.filter(excludesSelf).map((proposal) => ({ proposal, sourceType: 'feedback' as const })),
  ];

  if (census) {
    // repoRootFromModule(__filename), NOT import.meta.url: pa/ compiles to CommonJS
    // (tsconfig module Node16, no "type":"module") — a literal `import.meta` in emitted
    // output makes Node auto-detect the file as ESM and the whole CLI dies at startup
    // ("exports is not defined", live incident 2026-08-23, pa/src/lib/git-root.ts:56-61).
    // Every other repoRootFromModule call site in this tree (scheduler.ts, the three
    // maintenance job files) already uses __filename for the same reason.
    const repoRoot = await repoRootFromModule(__filename);
    const censusPairs = censusProposals(census, {
      skills: await listSkills(),
      maintenanceJobNames: jobsForHost('pa').map((j) => j.name),
      jobFileExists: (p) => existsSync(join(repoRoot, p)),
    });
    for (const { proposal, evidence } of censusPairs) {
      if (!excludesSelf(proposal)) continue;
      tagged.push({ proposal, sourceType: 'failure' as const, evidence });
    }
  }

  const toGate: GeneratedProposals['toGate'] = [];
  const skipped: ReportEntry[] = [];

  for (const { proposal, sourceType, evidence } of tagged) {
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
    toGate.push({ proposal, sourceType, evidence });
  }

  return { toGate, skipped };
}

// Per-run bounds for autonomous code fixes (2026-08-23 F5 rework — the global
// one-fix-per-night cap is gone, see plans/2026-08-23-code-fix-multi-per-night-SPEC.md).
// PA_SELF_IMPROVER_CODE_FIX_BUDGET_MS: wall-clock budget for code-fix attempts in one run
// (default 40 min, comfortably inside the 60-min skill timeout given observed 12-20 min/fix).
export function readCodeFixBudgetMs(): number {
  return Number(process.env.PA_SELF_IMPROVER_CODE_FIX_BUDGET_MS) || 40 * 60_000;
}

// PA_SELF_IMPROVER_MAX_CODE_FIXES: optional hard cap on code-fix attempts per run.
// Unset/0/non-finite = unlimited (the per-target + disjoint-files + budget bounds carry the
// safety property now, so there's no default count ceiling).
export function readMaxCodeFixes(): number {
  const n = Number(process.env.PA_SELF_IMPROVER_MAX_CODE_FIXES);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
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
  // Deliberately NO default here (unlike every Fn above) — the bounded validation retry below
  // only runs when a caller opts in by passing this. main() wires the real regenerateProposal;
  // every existing test that exercises "validation fails -> validation-failed-pending" without
  // passing this keeps behaving exactly as it did before retry existed, since the retry loop's
  // `regenerateProposalFn &&` check short-circuits on undefined.
  regenerateProposalFn?: typeof regenerateProposal;
  updateDraftPromptFn?: typeof updateDraftPrompt;
  /** Test-only clock injection for the per-run code-fix wall-clock budget below. */
  nowFn?: () => number;
  /** Per-run wall-clock budget for autonomous code fixes; default readCodeFixBudgetMs(). */
  codeFixBudgetMs?: number;
  /** Hard cap on code-fix attempts per run; default readMaxCodeFixes() (unlimited unless set). */
  maxCodeFixes?: number;
}

// 1 initial validation attempt + 1 retry-with-judge-feedback before parking as
// validation-failed-pending (2026-07-29 autonomy pass). Bounded deliberately: each retry is
// still the same fails-closed LLM-judged check, so this doesn't change the trust model, only
// gives a plausibly-close proposal one more autonomous shot instead of dead-ending immediately.
const MAX_VALIDATION_ATTEMPTS = 2;

export async function gateAndApprove(
  tagged: Array<{ proposal: DraftProposal; sourceType: 'conversation' | 'failure' | 'feedback'; evidence?: FailureRecord[] }>,
  deps: GateDeps = {}
): Promise<ReportEntry[]> {
  const {
    validateNewSkillFn = validateNewSkill,
    validateSkillFixFn = validateSkillFix,
    applyFixFn = applyFix,
    approveDraftFn = approveDraft,
    attemptCodeFixFn = attemptCodeFix,
    readRecentFailuresFn = readRecentFailures,
    regenerateProposalFn,
    updateDraftPromptFn = updateDraftPrompt,
    nowFn = Date.now,
    codeFixBudgetMs = readCodeFixBudgetMs(),
    maxCodeFixes = readMaxCodeFixes(),
  } = deps;

  const entries: ReportEntry[] = [];
  // F5 rework (2026-08-23, plans/2026-08-23-code-fix-multi-per-night-SPEC.md): the global
  // one-fix-per-night cap is gone. Blast radius + rollback attribution are now bounded by,
  // per run: one attempt per target skill (attemptedTargets), disjoint files across every
  // applied fix so each stays independently git-revertable (sameRunAppliedFiles, enforced by
  // code-fixer's same-run-overlap guard), and a wall-clock budget (runStartedAt/codeFixBudgetMs)
  // so a fix is never started that the skill timeout could kill mid-verification. An optional
  // hard count cap (maxCodeFixes, default unlimited) is kept as a belt-and-suspenders knob.
  const runStartedAt = nowFn();
  const attemptedTargets = new Set<string>();
  const sameRunAppliedFiles: string[] = [];
  let codeFixAttempts = 0;

  // Shared body for BOTH cmd-based-skill targets and maintenance-job targets (2026-08-23,
  // §WP-J2b step 3c) — the two branches below differ only in how they decided to get here
  // (isCmdBasedTarget vs. proposal.target_kind === 'maintenance-job'); once here, routing to
  // the autonomous code-fixer is identical, evidence included: `presetEvidence` carries the
  // census's own synthesized FailureRecord when this proposal came from censusProposals
  // (decision (i) — gateAndApprove's readRecentFailuresFn lookup returns [] for a maintenance
  // job, since it is keyed on a skill log directory a declared job doesn't have), and falls
  // back to the pre-existing readRecentFailuresFn lookup otherwise.
  const runCodeFixRoute = async (
    proposal: DraftProposal,
    sourceType: 'conversation' | 'failure' | 'feedback',
    riskFlags: string[],
    presetEvidence: FailureRecord[] | undefined,
  ): Promise<void> => {
    const base = { name: proposal.name, sourceType, reason: proposal.reason, targetSkill: proposal.target_skill };
    const targetSkill = proposal.target_skill!;

    // A cmd-based skill's real behavior lives in its script, not its prompt (and a
    // maintenance-job target has no skill.md at all) — so instead of parking a no-op prompt
    // fix, route the failure evidence to the autonomous code-fixer. The prompt-fix DRAFT
    // itself is never deployed either way: it's marked rejected_auto and serves as the
    // trigger record; the actual fix (if any) lands as a git commit. attemptCodeFix appends
    // its own audit records for every outcome (applied, reverted, every skip reason) — the
    // rejected_auto record below covers only the draft's fate.
    await markDraftMeta(proposal.name, { status: 'rejected_auto' });
    await appendAuditRecord({
      ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
      target_skill: proposal.target_skill, action: 'rejected_auto', risk_flags: riskFlags,
      reason: proposal.reason,
    });

    if (attemptedTargets.has(targetSkill)) {
      entries.push({ ...base, outcome: 'code-fix-skipped-target-already-attempted', riskFlags });
      return;
    }
    if (codeFixAttempts >= maxCodeFixes) {
      entries.push({ ...base, outcome: 'code-fix-skipped-limit-reached', riskFlags, detail: `max ${maxCodeFixes} per run (PA_SELF_IMPROVER_MAX_CODE_FIXES)` });
      return;
    }
    if (nowFn() - runStartedAt > codeFixBudgetMs) {
      entries.push({ ...base, outcome: 'code-fix-skipped-budget-exhausted', riskFlags, detail: `elapsed ${Math.round((nowFn() - runStartedAt) / 60000)}m ≥ budget ${Math.round(codeFixBudgetMs / 60000)}m (PA_SELF_IMPROVER_CODE_FIX_BUDGET_MS)` });
      return;
    }

    attemptedTargets.add(targetSkill);
    codeFixAttempts++;

    const evidence = presetEvidence ?? (await readRecentFailuresFn(ANALYSIS_DAYS))
      .filter((f) => f.skillName === targetSkill);
    const result = await attemptCodeFixFn(proposal, evidence, { sameRunAppliedFiles: [...sameRunAppliedFiles] });
    if (result.outcome === 'applied-code-fix' && result.filesChanged) {
      sameRunAppliedFiles.push(...result.filesChanged);
    }
    // WP-P1 (2026-08-24): attemptCodeFixFn's own audit record's `ts` is generated inside
    // code-fixer.ts and is not returned on CodeFixResult, so the exact ts of the record THIS
    // entry produced is looked up back out of the audit trail by commit_hash — the same
    // pattern rollback()'s git-revert branch already uses above. Left undefined (not
    // invented) when there is no commit hash to key on, so a HITL send for this entry is
    // skipped rather than risking a `pm:` id that can't be found later.
    let auditTs: string | undefined;
    if (result.outcome === 'applied-code-fix' && result.commitHash) {
      const record = (await readAuditRecords()).find(
        (r) => r.action === 'applied-code-fix' && r.commit_hash === result.commitHash);
      auditTs = record?.ts;
    }
    entries.push({ ...base, outcome: result.outcome, riskFlags, detail: result.reason, ts: auditTs });
  };

  for (const { proposal, sourceType, evidence: presetEvidence } of tagged) {
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
      let current = proposal;
      let detail: AuditValidation = {};
      let valid = await validateNewSkillFn(current, undefined, (d) => { detail = d; });
      let attempts = 1;
      while (!valid && regenerateProposalFn && attempts < MAX_VALIDATION_ATTEMPTS) {
        const revised = await regenerateProposalFn(current, detail.judge_excerpt ?? 'Validation failed (dry run did not succeed).');
        if (!revised) break;
        current = revised;
        valid = await validateNewSkillFn(current, undefined, (d) => { detail = d; });
        attempts++;
      }

      if (valid) {
        if (attempts > 1) await updateDraftPromptFn(current.name, current.frontmatter, current.prompt);
        await approveDraftFn(current.name, { approved_autonomously: true, risk_flags: riskFlags });
        // WP-P1 (2026-08-24): captured once and reused on both the report entry and the
        // audit record so a later `pm:<ts>:approve` press keys on the SAME record this
        // entry produced (§WP-P1 step 1 — "auditTs is the ts of the audit record this
        // entry produced").
        const auditTs = new Date().toISOString();
        entries.push({ ...base, outcome: 'approved-new-skill', riskFlags, ts: auditTs, ...(attempts > 1 ? { detail: `validated on retry ${attempts}` } : {}) });
        await appendAuditRecord({
          ts: auditTs, draft: proposal.name, source_type: sourceType,
          action: 'approved-new-skill', risk_flags: riskFlags, reason: proposal.reason,
          validation: detail, diff: current.prompt.slice(0, 4000),
        });
      } else {
        entries.push({ ...base, outcome: 'validation-failed-pending', riskFlags });
        await appendAuditRecord({
          ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
          action: 'validation-failed', risk_flags: riskFlags, reason: proposal.reason,
          validation: detail, diff: current.prompt.slice(0, 4000),
        });
      }
    } else if (proposal.target_kind === 'maintenance-job') {
      // A census proposal naming a declared maintenance job (2026-08-23) — no skill.md exists
      // to prompt-fix, so this never calls isCmdBasedTarget or loadSkill; it routes straight
      // to the same code-fix closure the cmd-based-skill branch below uses.
      await runCodeFixRoute(proposal, sourceType, riskFlags, presetEvidence);
    } else if (await isCmdBasedTarget(proposal.target_skill)) {
      await runCodeFixRoute(proposal, sourceType, riskFlags, presetEvidence);
    } else {
      // Capture the OLD prompt BEFORE applyFixFn overwrites target_skill's skill.md, so the
      // audit diff shows what actually changed — after applyFixFn, loadSkill would return
      // the NEW prompt instead.
      let oldPrompt = '';
      try { oldPrompt = (await loadSkill(proposal.target_skill)).prompt; } catch { /* best-effort */ }

      let current = proposal;
      let detail: AuditValidation = {};
      let valid = await validateSkillFixFn(current, undefined, undefined, (d) => { detail = d; });
      let attempts = 1;
      while (!valid && regenerateProposalFn && attempts < MAX_VALIDATION_ATTEMPTS) {
        const revised = await regenerateProposalFn(current, detail.judge_excerpt ?? 'Validation failed (dry run did not succeed or judge rejected it).');
        if (!revised) break;
        current = revised;
        valid = await validateSkillFixFn(current, undefined, undefined, (d) => { detail = d; });
        attempts++;
      }

      if (valid) {
        // Wave H WPH1: Run the golden-task eval gate (SOFT in v1 — informs, doesn't gate)
        const evalResult = await runEvalGate({
          skillName: proposal.target_skill!,
          changedPrompt: current.prompt,
          fullEval: false // v1: deterministic-only subset
        });

        // If eval fails, park as validation-failed-pending with eval detail (NOT auto-reject)
        if (evalResult.fail > 0) {
          entries.push({
            ...base,
            outcome: 'validation-failed-pending',
            riskFlags,
            detail: `Eval gate failed (${formatEvalDetail(evalResult)}) — parked for human review via \`pa improvements\``
          });
          await appendAuditRecord({
            ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
            target_skill: proposal.target_skill, action: 'validation-failed', risk_flags: riskFlags,
            reason: proposal.reason, validation: detail, diff: unifiedDiff(oldPrompt, current.prompt),
            eval: {
              pass: evalResult.pass,
              fail: evalResult.fail,
              skipped: evalResult.skipped,
              detail: formatEvalDetail(evalResult)
            }
          });
          continue; // Skip the apply path
        }

        await applyFixFn(current, riskFlags);
        // WP-P1 (2026-08-24): captured once and reused on both the report entry and the
        // audit record — see the identical note on the approved-new-skill path above.
        const auditTs = new Date().toISOString();
        entries.push({
          ...base,
          outcome: 'applied-fix',
          riskFlags,
          ts: auditTs,
          detail: `overwrote \`${proposal.target_skill}\` (backup: \`${proposal.name}/target-backup.skill.md\`)${attempts > 1 ? ` — validated on retry ${attempts}` : ''}`,
        });
        await appendAuditRecord({
          ts: auditTs, draft: proposal.name, source_type: sourceType,
          target_skill: proposal.target_skill, action: 'applied-fix', risk_flags: riskFlags,
          reason: proposal.reason, validation: detail, diff: unifiedDiff(oldPrompt, current.prompt),
          backup_path: join(draftsDir(), proposal.name, 'target-backup.skill.md'),
          baseline: toAuditBaseline(await skillRunStats(proposal.target_skill, ANALYSIS_DAYS)),
          eval: {
            pass: evalResult.pass,
            fail: evalResult.fail,
            skipped: evalResult.skipped,
            detail: formatEvalDetail(evalResult)
          }
        });
      } else {
        entries.push({ ...base, outcome: 'validation-failed-pending', riskFlags });
        await appendAuditRecord({
          ts: new Date().toISOString(), draft: proposal.name, source_type: sourceType,
          target_skill: proposal.target_skill, action: 'validation-failed', risk_flags: riskFlags,
          reason: proposal.reason, validation: detail, diff: unifiedDiff(oldPrompt, current.prompt),
        });
      }
    }
  }

  return entries;
}

function riskFlagSuffix(e: ReportEntry): string {
  return e.riskFlags && e.riskFlags.length > 0 ? ` [risk: ${e.riskFlags.join(', ')}]` : '';
}

export function buildReport(
  rollbackLines: string[],
  entries: ReportEntry[],
  staleCount: number = 0,
  purgedCount: number = 0,
  census?: AlertCensus,
  censusError?: string,
): string {
  const applied = entries.filter((e) => e.outcome === 'approved-new-skill' || e.outcome === 'applied-fix' || e.outcome === 'applied-code-fix');
  const pending = entries.filter((e) => e.outcome === 'validation-failed-pending');
  const autoRejected = entries.filter((e) => e.outcome === 'auto-rejected-cmd-target');
  const skipped = entries.filter((e) => e.outcome === 'skipped-duplicate-pending' || e.outcome === 'skipped-cooldown');
  const blocked = entries.filter((e) => e.outcome === 'blocked-protected');
  const codeFixReverted = entries.filter((e) => e.outcome === 'code-fix-reverted');
  const codeFixSkipped = entries.filter((e) => e.outcome.startsWith('code-fix-skipped-'));

  const lines: string[] = [];
  lines.push(`Analyzed the last ${ANALYSIS_DAYS} days. ${entries.length} proposal(s) generated.`);
  // ALWAYS printed, even with zero proposals — "0 proposals — nothing to report" while ~110
  // alerts/day fired is exactly the failure this line exists to make impossible (2026-08-23,
  // plans/2026-08-23-alerts-week-review.md §4).
  lines.push(census ? census.topLine : `Alert census unavailable: ${censusError ?? 'not built'}`);
  lines.push('');

  if (rollbackLines.length > 0) {
    lines.push(`*Rollbacks (${rollbackLines.length})*`);
    lines.push(...rollbackLines);
    lines.push('');
  }

  if (census) {
    const humanGated = census.families.filter((f) => f.classification === 'human-gated' && !f.suppressedBy);
    const repeatUnchanged = census.families.filter((f) => f.classification === 'repeat-unchanged' && !f.suppressedBy);
    // Reference point for "age since firstSeen" is the census's own generatedAt (not
    // Date.now()) so buildReport stays a pure function of its inputs, unit-testable without a
    // clock dependency.
    const nowMs = Date.parse(census.generatedAt);

    if (humanGated.length > 0) {
      lines.push(`*Operator action needed (${humanGated.length})*`);
      for (const f of humanGated) {
        const ageDays = Math.max(0, Math.round((nowMs - Date.parse(f.firstSeen)) / 86_400_000));
        const err = (f.ownerStatus?.lastError ?? f.bodySample ?? '').slice(0, 200);
        lines.push(`- \`${f.family}\` (owner: ${f.owner ?? 'unknown'}) — ${ageDays}d old, last error: ${err}${f.regressedAfterFix ? ` ⚠ recurred after fix ${f.fixedAt}` : ''}`);
      }
      lines.push('');
    }

    if (repeatUnchanged.length > 0) {
      lines.push(`*Alert hygiene (${repeatUnchanged.length})*`);
      for (const f of repeatUnchanged) {
        lines.push(`- \`${f.family}\` — sent ${f.sent}, ${f.distinctBodies} distinct bod${f.distinctBodies === 1 ? 'y' : 'ies'} — escalate / merge / mute${f.regressedAfterFix ? ` ⚠ recurred after fix ${f.fixedAt}` : ''}`);
      }
      lines.push('');
    }

    // One trace line so suppressed families are visibly accounted for, not
    // silently gone (2026-08-29). Regressions are NOT suppressed and resurface
    // with a ⚠ marker on their own line.
    const suppressedFamilies = census.families.filter((f) => f.suppressedBy);
    if (suppressedFamilies.length > 0) {
      const byFixRecord = suppressedFamilies.filter((f) => f.suppressedBy === 'fix-record').length;
      const byGreen = suppressedFamilies.length - byFixRecord;
      lines.push(`Known-fixed suppressed: ${suppressedFamilies.length} (${byFixRecord} fix-record, ${byGreen} green-signal; recurrences resurface)`);
      lines.push('');
    }

    if (census.maskedFailures.length > 0) {
      lines.push(`*Masked failures (${census.maskedFailures.length})*`);
      for (const m of census.maskedFailures) {
        lines.push(`- \`${m.skill}\` (last run ${m.lastRunAt}): ${m.marker}`);
      }
      lines.push('');
    }
  }

  if (staleCount > 0) {
    lines.push(`*Stale drafts reaped (${staleCount})* — pending >${STALE_DRAFT_DAYS} days; re-propose if still real.`);
    lines.push('');
  }

  if (purgedCount > 0) {
    lines.push(`*Rejected drafts purged (${purgedCount})* — terminal rejections removed from disk; fingerprints no longer block re-proposals.`);
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

// --- HITL keyboard sends (WP-P1, 2026-08-24, plans/2026-08-24-buttons-program-SPEC.md §WP-P1) ---
//
// Two ADDITIONAL per-item sends appended after the one nightly report notifyUser above (spec
// correction 14) — the report itself never changes. Both loops in the spec are combined here
// into one pure selector (`selectHitlMessages`) plus one send loop in main(), sharing a single
// 10-message-per-run budget ("Cap at 10 messages per run" — spec §WP-P1 step 3 states the cap
// under the shared "both loops" bullet, not per loop).
const HIGH_RISK_FLAGS = new Set(['critical-skill', 'declares-secrets']);

/** entries eligible for the risk-flagged-applied-change keyboard: APPLIED outcomes carrying a
 *  high-risk flag AND a known audit-record ts (spec correction 14 step 1 — an entry with no ts
 *  is skipped, never sent with an invented id). */
function isRiskFlaggedApplied(e: ReportEntry): boolean {
  return (
    (e.outcome === 'applied-fix' || e.outcome === 'approved-new-skill' || e.outcome === 'applied-code-fix') &&
    !!e.ts &&
    !!e.riskFlags?.some((f) => HIGH_RISK_FLAGS.has(f))
  );
}

// SPEC CORRECTION (not in the FIXED spec's corrections list — found while implementing WP-P1):
// §WP-P1 step 2 says `outcome === 'validation-failed'`, but ReportEntry's real outcome union
// (this file, above) has no such value — the actual value written by gateAndApprove for a
// draft parked by failed validation is 'validation-failed-pending' (used consistently at every
// call site, e.g. the `pending` filter in buildReport just above). 'validation-failed' would
// fail to typecheck (TS2367, no overlap) and noEmitOnError would fail the build. Implemented
// against the real value; flagged here for the spec to be corrected upstream.
function isPendingDraft(e: ReportEntry): boolean {
  return e.outcome === 'validation-failed-pending' && buildDraftKeyboard(e.name) !== undefined;
}

export interface HitlMessage {
  kind: 'risk-flagged' | 'pending-draft';
  entry: ReportEntry;
}

export interface HitlSelection {
  messages: HitlMessage[];
  /** How many qualified before the cap was applied — used to log an honest "N more eligible"
   *  line rather than silently dropping them. */
  totalEligible: number;
}

export const HITL_MESSAGE_CAP = 10;

/** Pure. Risk-flagged applied changes are selected before pending drafts (matching the spec's
 *  step 1-then-step-2 ordering), then both are capped together at HITL_MESSAGE_CAP. */
export function selectHitlMessages(entries: ReportEntry[]): HitlSelection {
  const riskFlagged = entries.filter(isRiskFlaggedApplied);
  const pendingDrafts = entries.filter(isPendingDraft);
  const all: HitlMessage[] = [
    ...riskFlagged.map((entry) => ({ kind: 'risk-flagged' as const, entry })),
    ...pendingDrafts.map((entry) => ({ kind: 'pending-draft' as const, entry })),
  ];
  return { messages: all.slice(0, HITL_MESSAGE_CAP), totalEligible: all.length };
}

/** Sends the per-item HITL keyboard messages selected by selectHitlMessages. Each send is
 *  independently wrapped so one failure logs and continues — this must never abort or throw,
 *  since it runs after the nightly report has already been sent (spec step 3). */
async function sendHitlMessages(entries: ReportEntry[]): Promise<void> {
  const selection = selectHitlMessages(entries);
  if (selection.totalEligible > selection.messages.length) {
    console.log(`[self-improver] HITL send cap reached: ${selection.totalEligible} eligible, sending ${selection.messages.length} (cap ${HITL_MESSAGE_CAP})`);
  }

  for (const msg of selection.messages) {
    const e = msg.entry;
    try {
      if (msg.kind === 'risk-flagged') {
        const body = `Target: ${e.targetSkill ?? e.name}\nRisk flags: ${(e.riskFlags ?? []).join(', ')}\nReason: ${e.reason}`;
        await notifyUser(`Risk-flagged change applied: ${e.name}`, body, {
          topic: await getReportTopic(),
          severity: 'warn',
          dedupKey: `hitl-applied-${e.ts}`,
          dedupWindowMs: 24 * 3_600_000,
          escalate: false,
          // NotifyOpts.replyMarkup is `Record<string, unknown>` (pre-work P4, FROZEN) —
          // HitlKeyboard has no index signature, so a named-type value needs the
          // double-cast escape hatch here even though it satisfies the shape at runtime.
          replyMarkup: buildHITLKeyboard({ risk_flags: e.riskFlags, ts: e.ts }) as unknown as Record<string, unknown> | undefined,
        });
      } else {
        const body = `Reason: ${e.reason}\n\nTyped fallback: \`pa approve ${e.name}\` / \`pa reject ${e.name}\``;
        await notifyUser(`Draft pending review: ${e.name}`, body, {
          topic: await getReportTopic(),
          dedupKey: `hitl-draft-${e.name}`,
          dedupWindowMs: 7 * 86_400_000,
          escalate: false,
          replyMarkup: buildDraftKeyboard(e.name) as unknown as Record<string, unknown> | undefined,
        });
      }
    } catch (err: any) {
      console.error(`[self-improver] HITL send failed for ${msg.kind} '${e.name}': ${err?.stack || err}`);
    }
  }
}

async function main() {
  const rollbackLines = await rollback();
  const staleCount = await sweepStaleDrafts();
  const purgedCount = await cleanRejected();
  // In-process build (2026-08-23) — keeps this loop independent of the alert-census
  // maintenance job's own schedule; that job's ~/.pa/alert-census.json is for the weekly
  // digest, not for this. Never let a census build failure abort the whole nightly run.
  let censusError: string | undefined;
  // 7 days, NOT ANALYSIS_DAYS: the alert-census maintenance job and weekly_digest.py's
  // "Alerts (7d)" section use a 7-day window; a 14-day copy here would let the same family
  // classify differently in the nightly report vs the digest (wave verifier, 2026-08-23).
  const census = await buildAlertCensus({ days: 7 }).catch((err) => {
    censusError = String(err?.message ?? err);
    return undefined;
  });
  const { toGate, skipped } = await generateProposals(census);
  const gateEntries = await gateAndApprove(toGate, { regenerateProposalFn: regenerateProposal });
  const entries = [...skipped, ...gateEntries];
  const report = buildReport(rollbackLines, entries, staleCount, purgedCount, census, censusError);

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

  // WP-P1 (2026-08-24): per-item HITL keyboard sends, additional to the report above (spec
  // correction 14) — never allowed to abort the nightly run (each send is individually
  // try/caught inside sendHitlMessages).
  await sendHitlMessages(entries);
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
