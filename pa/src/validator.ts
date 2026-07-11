import { mkdir, copyFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { draftsDir } from './paths.js';
import { listSkills, loadSkill } from './skills.js';
import { serializeSkillMd, markDraftMeta } from './drafts.js';
import { runWithFailover } from './workers.js';
import { readRecentConversations } from './analyzer.js';
import { readRecentFailures } from './failure-analyzer.js';
import type { ConversationTurn } from './analyzer.js';
import type { DraftProposal } from './types.js';
import type { AuditValidation } from './lib/improvement-audit.js';

// Skills the self-improvement loop must never modify or roll back, regardless of what any
// proposal claims to target — defense in depth beyond the exclusion filter in
// self-improver.ts's generateProposals(). This is the ONLY unconditional block remaining in
// the fully autonomous regime (2026-07-11): isCriticalChange and hasRealSideEffects below are
// now risk *flags* recorded alongside an applied change, not gates that prevent it.
const PROTECTED_SKILLS = new Set(['self-improver']);

/**
 * Hard block — the self-improvement loop must never modify or roll back this skill, no
 * matter what any proposal claims to target. Split out from isCriticalChange (2026-07-11)
 * so the self-guard is an explicit, always-unconditional check, distinct from the
 * `critical: true` frontmatter flag below, which is now advisory only.
 */
export function isProtected(proposal: DraftProposal): boolean {
  if (PROTECTED_SKILLS.has(proposal.name)) return true;
  if (proposal.target_skill && PROTECTED_SKILLS.has(proposal.target_skill)) return true;
  return false;
}

/**
 * True if approving/applying this proposal would touch a skill flagged `critical: true` in
 * its own frontmatter. For a fix/reinforce proposal, "the skill it touches" is
 * `target_skill`; for a brand-new skill proposal (no target_skill), it's the proposal's own
 * name — but a name that doesn't exist yet in `listSkills()` is never critical by definition.
 *
 * No longer a gate (2026-07-11 full-autonomy regime) — gateAndApprove records this as a
 * 'critical-skill' risk flag on the applied change instead of routing to manual review.
 * Self-improver protection lives in isProtected() above, not here.
 */
export async function isCriticalChange(proposal: DraftProposal): Promise<boolean> {
  const targetName = proposal.target_skill ?? proposal.name;
  const skills = await listSkills();
  const target = skills.find((s) => s.name === targetName);
  return target?.frontmatter.critical === true;
}

/**
 * True if this proposal (or, for a fix, its existing target skill) declares any secrets —
 * a proxy for "this skill performs real external side effects" (sending a Telegram message,
 * an email, etc.). Validation runs the skill for real, not in a sandbox.
 *
 * No longer a gate (2026-07-11 full-autonomy regime) — gateAndApprove records this as a
 * 'declares-secrets' risk flag on the applied change instead of routing to manual review.
 */
export async function hasRealSideEffects(proposal: DraftProposal): Promise<boolean> {
  if (proposal.frontmatter.secrets && proposal.frontmatter.secrets.length > 0) return true;

  if (proposal.target_skill) {
    const skills = await listSkills();
    const target = skills.find((s) => s.name === proposal.target_skill);
    if (target?.frontmatter.secrets && target.frontmatter.secrets.length > 0) return true;
  }

  return false;
}

async function loadTurnsByIds(ids: string[]): Promise<ConversationTurn[]> {
  if (ids.length === 0) return [];
  // 30-day window is generous relative to the analyzers' default 14-day lookback, so a
  // proposal's source turns are still findable even if validation runs a bit later.
  const turns = await readRecentConversations(30);
  const idSet = new Set(ids);
  return turns.filter((t) => t.message_id && idSet.has(t.message_id));
}

/**
 * Dry-run validation for a brand-new skill proposal: replay it against the original
 * conversation it was proposed from, then have the `gemini` worker judge whether the
 * output would have been a good, safe replacement.
 *
 * `onDetail`, if given, receives the intermediate validation detail (candidate-run success,
 * judge verdict, a truncated excerpt of the judge's raw output) for the eval-grade audit
 * trail (improvement-audit.ts) — an optional side channel rather than a return-type change,
 * so this stays a drop-in boolean predicate for every existing caller/test.
 */
export async function validateNewSkill(
  proposal: DraftProposal,
  runner: typeof runWithFailover = runWithFailover,
  onDetail?: (detail: AuditValidation) => void
): Promise<boolean> {
  const originalTurns = await loadTurnsByIds(proposal.source_message_ids);
  if (originalTurns.length === 0) return false; // nothing to validate against — fail safe

  const userText = originalTurns.filter((t) => t.role === 'user').map((t) => t.text).join('\n\n');
  if (!userText.trim()) return false;

  const { result: candidate } = await runner(`${proposal.prompt}\n\n---\n${userText}`, {
    resource: `self-improver-validate-${proposal.name}`,
    timeout: 300,
    idleTimeout: 120,
  });
  if (!candidate.success) {
    onDetail?.({ new_run_ok: false });
    return false;
  }

  const judgePrompt = `You are evaluating whether a proposed new automated skill would be a good, safe replacement for what happened in an original conversation.

## Original user request(s)
${userText}

## Original conversation (for context on what a good response looks like)
${originalTurns.map((t) => `[${t.role.toUpperCase()}] ${t.text.slice(0, 500)}`).join('\n')}

## Candidate skill output
${candidate.output.slice(0, 3000)}

## Task
Would this candidate output be a good, safe, automated replacement for what the user needed? Respond with ONLY the single word "true" or "false" — nothing else.`;

  const { result: judged } = await runner(judgePrompt, {
    resource: `self-improver-judge-${proposal.name}`,
    preferredWorker: 'gemini',
    timeout: 120,
    idleTimeout: 60,
  });
  if (!judged.success) {
    onDetail?.({ new_run_ok: true });
    return false;
  }

  const verdict = judged.output.trim().toLowerCase().startsWith('true');
  onDetail?.({ new_run_ok: true, judge_verdict: verdict, judge_excerpt: judged.output.trim().slice(0, 300) });
  return verdict;
}

/**
 * True if `targetSkillName` is a `cmd:`-based skill — its real behavior lives in the shell
 * command/script the frontmatter points to, not in the prompt/body markdown, so a fix
 * proposal (which only ever changes the prompt) is a no-op for it. Used by
 * self-improver.ts's gateAndApprove to auto-reject these immediately rather than let them
 * sit pending forever (2026-07-11). Returns false (not a crash) for a target that doesn't
 * resolve — the caller's own existence check is the source of truth for that.
 */
export async function isCmdBasedTarget(targetSkillName: string): Promise<boolean> {
  try {
    const target = await loadSkill(targetSkillName);
    return !!target.frontmatter.cmd;
  } catch {
    return false;
  }
}

/**
 * Evidence-judged dry-run validation for a fix/reinforce proposal (redesigned 2026-07-11).
 * The old "old prompt must still fail, new must succeed" semantics almost never passed — an
 * old prompt run bare, with none of the context that triggered the original failure, rarely
 * reproduces it — so real fixes piled up pending forever instead of ever autonomously
 * applying. Now: run the NEW prompt once (it must succeed on its own merits), then ask an
 * LLM judge whether it plausibly addresses the skill's recorded failure evidence while
 * preserving its documented purpose (the target's current prompt, as a proxy for "what this
 * skill is for"). Fails closed (false) whenever it can't get a confident "true" — a false
 * negative just leaves the draft pending (reaped by the staleness sweep eventually), not
 * silently deployed.
 *
 * Not meaningful for `cmd:`-based target skills — see isCmdBasedTarget(). Kept as an inline
 * fail-closed check here too (defense in depth: gateAndApprove auto-rejects these before
 * ever calling this function, but this function must never trust that it always will).
 *
 * `runner` and `judge` are separately injectable so tests can control the new-prompt-run
 * result and the judge verdict independently (matches the runner-injection pattern used
 * throughout this file and analyzer.ts/failure-analyzer.ts). `onDetail`, if given, receives
 * the intermediate validation detail for the eval-grade audit trail (improvement-audit.ts) —
 * an optional side channel rather than a return-type change, so this stays a drop-in boolean
 * predicate for every existing caller/test.
 */
export async function validateSkillFix(
  proposal: DraftProposal,
  runner: typeof runWithFailover = runWithFailover,
  judge: typeof runWithFailover = runWithFailover,
  onDetail?: (detail: AuditValidation) => void
): Promise<boolean> {
  if (!proposal.target_skill) return false;

  let target;
  try {
    target = await loadSkill(proposal.target_skill);
  } catch {
    return false;
  }
  if (target.frontmatter.cmd) return false;

  const { result: newResult } = await runner(proposal.prompt, {
    resource: `self-improver-validate-new-${proposal.name}`,
    timeout: 300,
    idleTimeout: 120,
  });
  if (!newResult.success) {
    onDetail?.({ new_run_ok: false });
    return false;
  }

  const failures = await readRecentFailures(14);
  const targetFailures = failures.filter((f) => f.skillName === proposal.target_skill);
  const evidenceBlock = targetFailures.length > 0
    ? targetFailures.map((f) => `- [${f.timestamp}] ${f.error}`).join('\n').slice(0, 2000)
    : '(no recorded failures matched this skill in the last 14 days)';

  const judgePrompt = `You are evaluating whether a proposed fix to an automated skill plausibly addresses its recorded failures while preserving its documented purpose.

## Skill's documented purpose (its current prompt, for context)
${target.prompt.slice(0, 1500)}

## Recorded failure evidence (last 14 days)
${evidenceBlock}

## Proposed new prompt
${proposal.prompt.slice(0, 1500)}

## New prompt's dry-run output
${newResult.output.slice(0, 2000)}

## Task
Does the new prompt plausibly address the recorded failures while preserving the skill's documented purpose? Respond with ONLY the single word "true" or "false" — nothing else.`;

  const { result: judged } = await judge(judgePrompt, {
    resource: `self-improver-judge-fix-${proposal.name}`,
    preferredWorker: 'gemini',
    timeout: 120,
    idleTimeout: 60,
  });
  if (!judged.success) {
    onDetail?.({ new_run_ok: true });
    return false;
  }

  const verdict = judged.output.trim().toLowerCase().startsWith('true');
  onDetail?.({ new_run_ok: true, judge_verdict: verdict, judge_excerpt: judged.output.trim().slice(0, 300) });
  return verdict;
}

/**
 * Apply a validated fix/reinforce proposal by overwriting `target_skill`'s own skill.md in
 * place — preserving its existing frontmatter (cron, telegram_output, secrets, etc.) and
 * swapping in only the proposal's new prompt. A copy of the pre-fix skill.md is kept
 * alongside the fix draft so Phase 4's rollback can restore it exactly if the fix makes
 * things worse. Never deploys a disconnected sibling skill under the draft's own name —
 * `approveDraft()` (for genuinely new skills) is a different, separate path.
 */
export async function applyFix(proposal: DraftProposal, riskFlags: string[] = []): Promise<void> {
  if (!proposal.target_skill) {
    throw new Error(`applyFix() called on proposal '${proposal.name}' with no target_skill`);
  }

  const target = await loadSkill(proposal.target_skill);

  const draftDir = join(draftsDir(), proposal.name);
  await mkdir(draftDir, { recursive: true });
  await copyFile(target.path, join(draftDir, 'target-backup.skill.md'));

  const composed = serializeSkillMd(target.frontmatter, proposal.prompt);
  await writeFile(target.path, composed, 'utf8');

  await markDraftMeta(proposal.name, {
    status: 'approved',
    approved_autonomously: true,
    applied_in_place: true,
    target_skill: proposal.target_skill,
    risk_flags: riskFlags,
  });
}
