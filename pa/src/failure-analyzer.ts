import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { logsDir } from './paths.js';
import { readLogs } from './logger.js';
import { listSkills } from './skills.js';
import { listDrafts, isDuplicate, computeFingerprint } from './drafts.js';
import { runWithFailover } from './workers.js';
import { parseProposalResponse } from './analyzer.js';
import { notifyUser } from './lib/notify.js';
import type { DraftProposal, RunMeta } from './types.js';

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
1. A modified skill prompt (as a new draft named "<skill-name>-fix") that addresses the root cause
2. A diagnostic skill that investigates why the failure keeps happening

Only propose fixes for patterns with 2+ failures. Ignore transient errors (network timeouts on a single day, etc.).

Respond with ONLY a JSON array (no markdown fences, no explanation):

[
  {
    "name": "skill-name-fix",
    "reason": "Why this fix addresses the failure pattern (1-2 sentences)",
    "source_message_ids": [],
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
