import { listSkills, loadSkill } from './skills.js';
import { listDrafts, isDuplicate, computeFingerprint, uniqueDraftName } from './drafts.js';
import { runWithFailover } from './workers.js';
import { parseProposalResponse, readRecentConversations } from './analyzer.js';
import type { ConversationTurn } from './analyzer.js';
import { notifyUser } from './lib/notify.js';
import { ANALYZER_TURN_CHARS } from './lib/skill-candidates.js';
import type { DraftProposal } from './types.js';
import { addRule, compileReactionCandidates, loadRules, auditTriageSkip } from './lib/feedback-rules.js';
import { decisionsDbPath } from './lib/decisions.js';

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
      const lines = dayTurns.map((t) => `[${t.role.toUpperCase()}] ${t.text.slice(0, ANALYZER_TURN_CHARS)}`).join('\n');
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

/**
 * Build the triage prompt for feedback rules (AI-165 WP-B).
 * Renders user turns only, reaction candidates, and existing rule keys.
 * Strict instruction: rules only TIGHTEN behavior (never grant permission, never loosen).
 */
export function buildRulesTriagePrompt(
  turns: ConversationTurn[],
  reactionCandidates: Array<{ rationale_key: string; rows: Array<{ decision_id: string; skill: string | null; source: string; decision: string; rationale: string; thread_id: number | null; ts: string }> }>,
  existingKeys: string[]
): string {
  // User turns only (capped at ANALYZER_TURN_CHARS per turn)
  const userTurns = turns.filter(t => t.role === 'user');
  const byDay = new Map<string, ConversationTurn[]>();
  for (const turn of userTurns) {
    const day = turn.timestamp.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(turn);
  }

  const conversationBlock = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayTurns]) => {
      const lines = dayTurns.map((t) => `[${t.role.toUpperCase()}] ${t.text.slice(0, ANALYZER_TURN_CHARS)}`).join('\n');
      return `## ${day}\n${lines}`;
    })
    .join('\n\n');

  // Render reaction candidates (rationale_key + each row's decision/rationale ≤200 chars)
  const candidatesBlock = reactionCandidates.map(candidate => {
    const rowsText = candidate.rows.map(row => {
      const decision = row.decision.slice(0, 200);
      const rationale = row.rationale.slice(0, 200);
      return `  - Decision: ${decision}\n    Rationale: ${rationale}`;
    }).join('\n');
    return `### ${candidate.rationale_key}\n${rowsText}`;
  }).join('\n\n');

  const existingKeysList = existingKeys.join(', ') || 'none';

  return `You are analyzing conversation history and negative reactions (👎) to extract standing behavioral rules that TIGHTEN the assistant's behavior.

## Conversation History (last ${[...byDay.keys()].length} days, user turns only)

${conversationBlock || '(no user conversations in this period)'}

${candidatesBlock ? `## Negative Reaction Candidates (≥2 👎 on similar decisions)\n\n${candidatesBlock}` : '(no reaction candidates)'}

## Existing Rule Keys (do NOT duplicate these keys)
${existingKeysList}

## Task

Extract rules that RESTRICT or TIGHTEN behavior. Rules must NEVER:
- Grant permission ("you may always", "no need to", "ignore", "skip")
- Loosen restrictions ("don't ask", "stop checking")

Only propose rules that ELIMINATE unwanted behavior or ENFORCE required behavior.

For each valid rule found:
- classification: "RULE"
- key: kebab-case slug (≤60 chars, /^[a-z0-9]+(-[a-z0-9]+)*$/)
- text: imperative instruction 1-140 chars (what the rule enforces)
- scope: "global" or "topic:<thread_id>" or "skill:<name>"
- check: {kind:"forbidden_phrase",phrase:"..."} OR {kind:"must_include",phrase:"..."} OR {kind:"max_length",max:N} OR null (semantic rule)
- origin: {thread_id, message_id} (turn-sourced) OR omit for reaction-sourced
- evidence_message_ids: array of message IDs supporting this rule

For corrections that are NOT rules (one-time fixes, vague feedback, nits):
- classification: "CORRECTION" or "NIT"
- note: why this is not a standing rule
- evidence_message_ids: array

Respond with ONLY a JSON array (no markdown fences, no explanation):

[
  {"classification":"RULE","key":"no-latex-telegram","text":"Never use LaTeX delimiters in Telegram replies.","scope":"global","check":{"kind":"forbidden_phrase","phrase":"\\frac"},"origin":{"thread_id":4242,"message_id":"48891"},"evidence_message_ids":["48891","48893"]},
  {"classification":"CORRECTION","note":"one-time substrate fix","evidence_message_ids":["48950"]},
  {"classification":"NIT","note":"too vague to codify","evidence_message_ids":["48960"]}
]

If no patterns found, respond with: []`;
}

/**
 * Parse rules triage response from LLM (AI-165 WP-B).
 * Strips markdown fences, parses JSON, validates shape.
 * Malformed rows drop silently. Returns RULE | CORRECTION | NIT rows.
 */
export function parseRulesResponse(raw: string): Array<{
  classification: 'RULE' | 'CORRECTION' | 'NIT';
  key?: string;
  text?: string;
  scope?: string;
  check?: { kind: string; phrase?: string; max?: number } | null;
  origin?: { thread_id?: number; message_id?: string };
  note?: string;
  evidence_message_ids: string[];
}> {
  // Strip markdown fences (inline pattern from analyzer.ts:121-131)
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  // Validate each row and filter malformed ones
  return parsed.filter((row: any) => {
    if (!row || typeof row !== 'object') return false;
    if (typeof row.classification !== 'string') return false;
    if (!['RULE', 'CORRECTION', 'NIT'].includes(row.classification)) return false;
    if (!Array.isArray(row.evidence_message_ids)) return false;

    // RULE rows require key, text, and scope
    if (row.classification === 'RULE') {
      if (typeof row.key !== 'string' || typeof row.text !== 'string' || typeof row.scope !== 'string') {
        return false;
      }
    }

    return true;
  });
}

/**
 * Analyze feedback patterns and mint rules (AI-165 WP-B rules lane).
 * Compiles reaction candidates from decisions.sqlite, runs triage LLM,
 * applies rule minting logic (auto-apply deterministic, pending semantic),
 * and logs triage skips. Never throws — failures log and return early.
 */
export async function analyzeFeedbackRules(
  turns: ConversationTurn[],
  runner: typeof runWithFailover = runWithFailover,
  ANALYSIS_DAYS: number = 14
): Promise<void> {
  try {
    // Compile reaction candidates (cutoff: ANALYSIS_DAYS ago)
    const cutoffIso = new Date(Date.now() - ANALYSIS_DAYS * 86400000).toISOString();
    const candidates = compileReactionCandidates(decisionsDbPath(), cutoffIso);

    // Load existing rule keys for dedup
    const existingRules = loadRules();
    const existingKeys = existingRules.filter(r => r.superseded_by === null).map(r => r.key);

    // Skip LLM call when no user turns AND no candidates
    const userTurns = turns.filter(t => t.role === 'user');
    if (userTurns.length === 0 && candidates.length === 0) {
      return;
    }

    const prompt = buildRulesTriagePrompt(turns, candidates, existingKeys);

    const { result } = await runner(prompt, {
      resource: 'feedback-rules-triage',
      timeout: 300,
      idleTimeout: 120,
    });

    if (!result.success) {
      // Log but don't throw — lane failure is noise, the weekly digest surfaces pending rules
      console.error('[feedback-analyzer] rules lane LLM failed:', result.error);
      return;
    }

    const parsed = parseRulesResponse(result.output);

    // Process each entry
    for (const entry of parsed) {
      if (entry.classification === 'CORRECTION' || entry.classification === 'NIT') {
        // Audit triage-skip for visibility
        auditTriageSkip({
          classification: entry.classification,
          note: entry.note,
          evidence_message_ids: entry.evidence_message_ids,
        });
        continue;
      }

      // RULE rows — validate and apply skip rules from §2.9
      if (entry.classification !== 'RULE') continue;
      if (!entry.key || !entry.text || !entry.scope) continue;

      // Check for duplicate key (non-superseded existing rule)
      const keyExists = existingRules.some(r => r.key === entry.key && r.superseded_by === null);
      if (keyExists) {
        auditTriageSkip({
          classification: 'RULE',
          reason: 'duplicate-key',
          evidence_message_ids: entry.evidence_message_ids,
        });
        continue;
      }

      // Check for decision_ids intersection (C8 dedup)
      if (entry.check && entry.origin && (entry.origin as any).decision_ids && (entry.origin as any).decision_ids.length > 0) {
        const hasIntersection = existingRules.some(r =>
          r.origin.decision_ids && r.origin.decision_ids.length > 0 &&
          r.origin.decision_ids.some((id: string) => (entry.origin as any).decision_ids!.includes(id))
        );
        if (hasIntersection) {
          auditTriageSkip({
            classification: 'RULE',
            reason: 'decision-id-intersection',
            evidence_message_ids: entry.evidence_message_ids,
          });
          continue;
        }
      }

      // Build origin — for reaction-sourced rules, copy decision_ids from candidates
      let origin: { thread_id: number | null; message_id: string | null; refId: string | null; ts: string; decision_ids: string[] } = {
        thread_id: null,
        message_id: null,
        refId: null,
        ts: new Date().toISOString(),
        decision_ids: []
      };
      if (entry.origin) {
        if (entry.origin.thread_id !== undefined) origin.thread_id = entry.origin.thread_id || null;
        if (entry.origin.message_id !== undefined) origin.message_id = entry.origin.message_id || null;
      }

      // C8 dedup: if this rule was inspired by a reaction candidate, copy its decision_ids
      // Match by scope+key pattern: a skill-scoped rule matches a candidate with same skill name
      if (entry.scope?.startsWith('skill:')) {
        const skillName = entry.scope.slice(7); // Remove 'skill:' prefix
        const candidate = candidates.find(c => c.rationale_key === skillName);
        if (candidate) {
          origin.decision_ids = candidate.rows.map(r => r.decision_id);
        }
      }

      // Determine status: check != null ⇒ active, check == null ⇒ pending (plan decision 2)
      const status = entry.check === null ? 'pending' : 'active';

      // Type-narrow check to RuleCheck if present
      let ruleCheck: any = null;
      if (entry.check && entry.check.kind) {
        if (entry.check.kind === 'forbidden_phrase' || entry.check.kind === 'must_include') {
          ruleCheck = { kind: entry.check.kind, phrase: entry.check.phrase || '' };
        } else if (entry.check.kind === 'max_length') {
          ruleCheck = { kind: entry.check.kind, max: entry.check.max || 100 };
        }
      }

      // Mint the rule via addRule (validation, redaction, supersede-by-key, audit all inside)
      const result = await addRule({
        key: entry.key,
        text: entry.text,
        scope: entry.scope,
        status,
        check: ruleCheck,
        origin,
      });

      if (!result.ok) {
        // Log validation/rejection failure as triage-skip
        auditTriageSkip({
          classification: 'RULE',
          reason: result.error || 'validation-failed',
          evidence_message_ids: entry.evidence_message_ids,
        });
      }
    }
  } catch (err: any) {
    // Never throw — log and return
    console.error('[feedback-analyzer] rules lane failed:', err);
  }
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

  // AI-165 WP-B: tail-step rules lane (nightly triage)
  await analyzeFeedbackRules(turns, runner).catch(() => {});

  return unique;
}
