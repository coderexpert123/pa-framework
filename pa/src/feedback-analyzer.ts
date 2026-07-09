import { listSkills, loadSkill } from './skills.js';
import { listDrafts, isDuplicate, computeFingerprint, uniqueDraftName } from './drafts.js';
import { runWithFailover } from './workers.js';
import { parseProposalResponse, readRecentConversations } from './analyzer.js';
import type { ConversationTurn } from './analyzer.js';
import { notifyUser } from './lib/notify.js';
import type { DraftProposal } from './types.js';

/**
 * Analyzes explicit user feedback about a SPECIFIC, EXISTING skill's behavior — corrections
 * ("stop doing X in the daily brief") and confirmations ("yes, keep doing Y that way") — and
 * proposes fix/reinforce drafts. Mirrors analyzer.ts/failure-analyzer.ts's shape exactly.
 *
 * Scope boundary: general conversational-assistant behavior feedback (tone, verbosity, how
 * Claude should collaborate) is NOT this analyzer's concern — that's already captured by the
 * separate Claude Code memory system (MEMORY.md / global CLAUDE.md). This analyzer only fires
 * when the feedback maps to a specific, existing `pa` skill named in `existingSkills`.
 */

export function buildFeedbackPrompt(
  turns: ConversationTurn[],
  existingSkills: string[],
  existingDrafts: string[]
): string {
  const byDay = new Map<string, ConversationTurn[]>();
  for (const turn of turns) {
    const day = turn.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(turn);
  }

  const conversationBlock = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayTurns]) => {
      const lines = dayTurns.map((t) => `[${t.role.toUpperCase()}] ${t.text.slice(0, 300)}`).join('\n');
      return `## ${day}\n${lines}`;
    })
    .join('\n\n');

  const exclusionList = [...existingSkills, ...existingDrafts].join(', ') || 'none';
  const skillList = existingSkills.join(', ') || 'none';

  return `You are analyzing a personal assistant's conversation history to find explicit user feedback about a SPECIFIC, EXISTING skill's recurring behavior.

## Conversation History (last ${[...byDay.keys()].length} days)

${conversationBlock || '(no conversations in this period)'}

## Existing Skills (feedback must map to one of these by exact name — do NOT propose anything for skills not in this list)
${skillList}

## Existing Drafts (do NOT re-propose these)
${exclusionList}

## Task

Identify two kinds of explicit feedback, each appearing 2+ times across DIFFERENT days, each clearly about ONE specific skill from the list above:

1. **Corrections** — the user telling the assistant to stop or change something about how a specific skill behaves (e.g. "the daily-mail-brief keeps including yesterday's stale entries, don't do that").
2. **Confirmations** — the user clearly and explicitly endorsing a specific, non-obvious approach a specific skill took (e.g. "yes, keep sending the reminder even on weekends, that's right").

STRICT SCOPE: only propose something when the feedback is about a NAMED, EXISTING skill's behavior. Do NOT propose anything for general feedback about the assistant's tone, verbosity, or how it should converse — that is handled elsewhere and is explicitly out of scope here. If you cannot map feedback to one specific existing skill by name, do not propose it.

For each qualifying pattern, propose a draft:
- Name it "<target-skill-name>-fix" for a correction, or "<target-skill-name>-reinforce" for a confirmation.
- Set "target_skill" to the EXACT existing skill name being corrected/confirmed (required, must be one of the names listed above).
- In "prompt", write ONLY the short instruction to apply — one or two sentences describing the specific behavior change, NOT a full skill prompt. You have not seen that skill's actual prompt text, so do not try to reproduce or rewrite it.

Respond with ONLY a JSON array (no markdown fences, no explanation):

[
  {
    "name": "skill-name-fix",
    "reason": "Why this reflects a real, repeated pattern (1-2 sentences)",
    "source_message_ids": [],
    "target_skill": "skill-name",
    "frontmatter": {},
    "prompt": "The short instruction to apply, e.g. 'Always exclude entries older than the current day.'"
  }
]

If no qualifying patterns exist, respond with: []`;
}

export async function analyzeFeedbackPatterns(
  days: number = 14,
  runner: typeof runWithFailover = runWithFailover
): Promise<DraftProposal[]> {
  const turns = await readRecentConversations(days);

  if (turns.length === 0) return [];

  const skills = await listSkills();
  const drafts = await listDrafts();

  const existingSkills = skills.map((s) => s.name);
  const existingDrafts = drafts.map((d) => d.skill.name);

  const prompt = buildFeedbackPrompt(turns, existingSkills, existingDrafts);

  const { result } = await runner(prompt, {
    resource: 'skill-feedback-analyzer',
    timeout: 300,
    idleTimeout: 120,
  });

  if (!result.success) {
    await notifyUser(
      'Feedback analyzer terminal failure',
      `The feedback pattern analyzer LLM run failed.\nError: ${(result.error ?? 'unknown').slice(0, 300)}`,
      { dedupKey: 'feedback-analyzer-terminal', severity: 'error' },
    ).catch(() => {});
  }

  const rawProposals = parseProposalResponse(result.output);

  // Reconstruct the full prompt in code from the target's real, current content — the LLM
  // was only ever given skill NAMES (existingSkills), never skill prompt bodies, so trusting
  // it to reproduce/merge a full prompt would risk hallucinating content it never saw.
  const reconstructed: DraftProposal[] = [];
  for (const proposal of rawProposals) {
    // This analyzer's entire purpose is skill-specific feedback — a proposal with no
    // target_skill (or one that doesn't resolve to a real skill) is malformed; drop it
    // rather than let it fall through to the "new skill" path it was never meant for.
    if (!proposal.target_skill) continue;

    let target;
    try {
      target = await loadSkill(proposal.target_skill);
    } catch {
      continue; // typo'd name, or the skill was deleted since the LLM call — skip silently
    }

    const instructionText = proposal.prompt.trim();
    const isReinforce = proposal.name.endsWith('-reinforce');
    const heading = isReinforce
      ? '## Reinforced instruction (from explicit user confirmation)'
      : '## Correction (from explicit user feedback)';

    reconstructed.push({
      ...proposal,
      prompt: `${target.prompt}\n\n${heading}\n${instructionText}`,
    });
  }

  // Deduplicate within batch and against saved state — mirrors failure-analyzer.ts, including
  // the fix-name collision avoidance (a target skill can be corrected/confirmed more than once
  // over time; the fixed "<target>-fix"/"<target>-reinforce" name must not block later ones).
  const seenNames = new Set<string>();
  const seenFingerprints = new Set<string>();
  const unique: DraftProposal[] = [];

  for (const proposal of reconstructed) {
    proposal.name = await uniqueDraftName(proposal.name);
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
