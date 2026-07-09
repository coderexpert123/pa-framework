import { mkdir, copyFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { draftsDir } from './paths.js';
import { listSkills, loadSkill } from './skills.js';
import { serializeSkillMd, markDraftMeta } from './drafts.js';
import { runWithFailover } from './workers.js';
import { readRecentConversations } from './analyzer.js';
import type { ConversationTurn } from './analyzer.js';
import type { DraftProposal } from './types.js';

// Skills the self-improvement loop must never modify or roll back, regardless of what any
// proposal claims to target — defense in depth beyond the `critical: true` frontmatter flag
// and the exclusion filter in self-improver.ts.
const PROTECTED_SKILLS = new Set(['self-improver']);

/**
 * True if approving/applying this proposal would touch a critical skill (or the
 * self-improver itself) and must therefore go to manual review instead of autonomous
 * approval. For a fix/reinforce proposal, "the skill it touches" is `target_skill`; for a
 * brand-new skill proposal (no target_skill), it's the proposal's own name — but a name
 * that doesn't exist yet in `listSkills()` is never critical by definition.
 */
export async function isCriticalChange(proposal: DraftProposal): Promise<boolean> {
  if (PROTECTED_SKILLS.has(proposal.name)) return true;
  if (proposal.target_skill && PROTECTED_SKILLS.has(proposal.target_skill)) return true;

  const targetName = proposal.target_skill ?? proposal.name;
  const skills = await listSkills();
  const target = skills.find((s) => s.name === targetName);
  return target?.frontmatter.critical === true;
}

/**
 * True if this proposal (or, for a fix, its existing target skill) declares any secrets —
 * a proxy for "this skill performs real external side effects" (sending a Telegram message,
 * an email, etc.). Validation runs the skill for real, not in a sandbox, so anything that
 * might have a real side effect is routed to manual review instead of autonomous validation.
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
 */
export async function validateNewSkill(
  proposal: DraftProposal,
  runner: typeof runWithFailover = runWithFailover
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
  if (!candidate.success) return false;

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
  if (!judged.success) return false;

  return judged.output.trim().toLowerCase().startsWith('true');
}

/**
 * Best-effort dry-run validation for a fix/reinforce proposal: re-run the current (old)
 * target skill and the proposed (new) prompt with no specific input, and only consider the
 * fix validated if the old one still reproduces a failure now AND the new one succeeds
 * cleanly. This can't reproduce every failure mode (many depend on external state at the
 * time of the original failure) — when it can't confirm a real fix, it fails closed to
 * manual review rather than guessing.
 *
 * Not meaningful for `cmd:`-based target skills: their real behavior lives in the shell
 * command/script the frontmatter points to, not in the prompt/body markdown — the only
 * thing a fix proposal ever changes. Feeding that descriptive text to an LLM as if it were
 * the skill doesn't test (or fix) anything real, so these always fail closed rather than
 * pretend to validate.
 */
export async function validateSkillFix(
  proposal: DraftProposal,
  runner: typeof runWithFailover = runWithFailover
): Promise<boolean> {
  if (!proposal.target_skill) return false;

  let target;
  try {
    target = await loadSkill(proposal.target_skill);
  } catch {
    return false;
  }
  if (target.frontmatter.cmd) return false;

  const { result: oldResult } = await runner(target.prompt, {
    resource: `self-improver-validate-old-${proposal.target_skill}`,
    timeout: 300,
    idleTimeout: 120,
  });
  const { result: newResult } = await runner(proposal.prompt, {
    resource: `self-improver-validate-new-${proposal.name}`,
    timeout: 300,
    idleTimeout: 120,
  });

  return !oldResult.success && newResult.success;
}

/**
 * Apply a validated fix/reinforce proposal by overwriting `target_skill`'s own skill.md in
 * place — preserving its existing frontmatter (cron, telegram_output, secrets, etc.) and
 * swapping in only the proposal's new prompt. A copy of the pre-fix skill.md is kept
 * alongside the fix draft so Phase 4's rollback can restore it exactly if the fix makes
 * things worse. Never deploys a disconnected sibling skill under the draft's own name —
 * `approveDraft()` (for genuinely new skills) is a different, separate path.
 */
export async function applyFix(proposal: DraftProposal): Promise<void> {
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
  });
}
