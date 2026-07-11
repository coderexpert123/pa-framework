import { createReadStream } from 'fs';
import { access } from 'fs/promises';
import { createInterface } from 'readline';
import { join } from 'path';
import { paHome } from './paths.js';
import { listSkills } from './skills.js';
import { listDrafts, isDuplicate, computeFingerprint } from './drafts.js';
import { runWithFailover } from './workers.js';
import { notifyUser } from './lib/notify.js';
import type { DraftProposal } from './types.js';

export interface ConversationTurn {
  role: string;
  text: string;
  timestamp: string;
  message_id?: string;
  thread_id?: number;
}

export async function readRecentConversations(days: number): Promise<ConversationTurn[]> {
  const filePath = join(paHome(), 'conversation-history.jsonl');

  try {
    await access(filePath);
  } catch {
    return [];
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const turns: ConversationTurn[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const turn = JSON.parse(trimmed) as ConversationTurn;
      if (new Date(turn.timestamp) >= cutoff) turns.push(turn);
    } catch {
      // skip malformed
    }
  }

  return turns;
}

export function buildAnalysisPrompt(
  turns: ConversationTurn[],
  existingSkills: string[],
  existingDrafts: string[]
): string {
  // Group turns by date (UTC day)
  const byDay = new Map<string, ConversationTurn[]>();
  for (const turn of turns) {
    const day = turn.timestamp.slice(0, 10); // YYYY-MM-DD
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

  return `You are analyzing a personal assistant's conversation history to identify repeated patterns that warrant automation as a "skill" (a reusable prompt template).

## Conversation History (last ${[...byDay.keys()].length} days)

${conversationBlock || '(no conversations in this period)'}

## Existing Skills (do NOT re-propose these)
${exclusionList}

## Task

Identify user requests that appear 3 or more times across DIFFERENT days. For each qualifying pattern, propose a skill definition.

Only propose skills for clear, actionable, repeatable tasks. Do NOT propose skills for one-off questions, conversational exchanges, or requests that are already covered by existing skills.

Respond with ONLY a JSON array (no markdown fences, no explanation). Each element must have these exact fields:

[
  {
    "name": "kebab-case-skill-name",
    "reason": "Why this pattern warrants a skill (1-2 sentences)",
    "source_message_ids": ["id1", "id2"],
    "frontmatter": {
      "cron": null,
      "trigger_description": "When to fire this skill automatically",
      "timeout": 300,
      "idle_timeout": 120
    },
    "prompt": "The full skill prompt in markdown"
  }
]

If no patterns qualify, respond with an empty array: []`;
}

export function parseProposalResponse(raw: string): DraftProposal[] {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    const lastFence = cleaned.lastIndexOf('```');
    if (firstNewline !== -1 && lastFence > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastFence).trim();
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const proposals: DraftProposal[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { name, reason, source_message_ids, frontmatter, prompt, target_skill, code_target } = item as Record<string, unknown>;

    if (typeof name !== 'string' || !name.trim()) continue;
    if (typeof reason !== 'string' || !reason.trim()) continue;
    if (typeof prompt !== 'string' || !prompt.trim()) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue; // injection guard
    // target_skill (when present and non-null) names an *existing* skill — same charset as
    // skill names, and must pass loadSkill()'s own traversal guard later. `null`/omitted both
    // mean "no target" (e.g. a brand-new skill, or failure-analyzer's diagnostic-skill option)
    // — only a non-null value that fails the shape check is treated as malformed.
    if (target_skill !== undefined && target_skill !== null
      && (typeof target_skill !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(target_skill))) continue;
    // code_target (2026-07-11, autonomous code-fix capability) — an LLM-proposed repo-relative
    // FILE path, not a skill name, so it needs its own charset + traversal guard rather than
    // reusing target_skill's. `null`/omitted both mean "no hint" (the common case — most
    // failure proposals won't name a specific file). A malformed value drops the WHOLE
    // proposal, same severity as a malformed target_skill — code-fixer.ts treats this as a
    // hint it will pass straight to a coding worker's brief, so it must never carry a
    // traversal/absolute-path payload through unvalidated.
    if (code_target !== undefined && code_target !== null
      && (typeof code_target !== 'string'
        || !/^[a-zA-Z0-9_][a-zA-Z0-9_.\-/]*$/.test(code_target)
        || code_target.includes('..')
        || code_target.startsWith('/')
        || /^[a-zA-Z]:/.test(code_target))) continue;

    proposals.push({
      name: name.trim(),
      reason: reason.trim(),
      source_message_ids: Array.isArray(source_message_ids)
        ? source_message_ids.filter((id) => typeof id === 'string')
        : [],
      frontmatter: typeof frontmatter === 'object' && frontmatter !== null
        ? frontmatter as Partial<DraftProposal['frontmatter']>
        : {},
      prompt: prompt.trim(),
      ...(typeof target_skill === 'string' && target_skill.trim() ? { target_skill: target_skill.trim() } : {}),
      ...(typeof code_target === 'string' && code_target.trim() ? { code_target: code_target.trim() } : {}),
    });
  }

  return proposals;
}

export async function analyzeConversationPatterns(
  days: number = 14,
  runner: typeof runWithFailover = runWithFailover
): Promise<DraftProposal[]> {
  const turns = await readRecentConversations(days);

  // Short-circuit: no conversations to analyze
  if (turns.length === 0) return [];

  const skills = await listSkills();
  const drafts = await listDrafts();

  const existingSkills = skills.map((s) => s.name);
  const existingDrafts = drafts.map((d) => d.skill.name);

  const prompt = buildAnalysisPrompt(turns, existingSkills, existingDrafts);

  const { result } = await runner(prompt, {
    resource: 'skill-learner',
    timeout: 300,
    idleTimeout: 120,
  });

  if (!result.success) {
    await notifyUser(
      'Analyzer terminal failure',
      `The conversation pattern analyzer LLM run failed.\nError: ${(result.error ?? 'unknown').slice(0, 300)}`,
      { dedupKey: 'analyzer-terminal', severity: 'error' },
    ).catch(() => {});
  }

  const proposals = parseProposalResponse(result.output);

  // Deduplicate: track seen names and fingerprints within this batch,
  // then check against existing saved state
  const seenNames = new Set<string>();
  const seenFingerprints = new Set<string>();
  const unique: DraftProposal[] = [];

  for (const proposal of proposals) {
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
