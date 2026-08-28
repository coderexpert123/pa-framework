import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import { listSkills as defaultListSkills } from '../../../skills.js';
import { getLastSuccessfulRun as defaultGetLastSuccessfulRun } from '../../../logger.js';
import { decisionStatsBySkill } from '../../decisions.js';
import { renameWithRetry } from '../state.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;
const STALE_DAYS = 90;

export interface SkillEngagementDeps {
  listSkills?: typeof defaultListSkills;
  getLastSuccessfulRun?: typeof defaultGetLastSuccessfulRun;
  decisionStats?: typeof decisionStatsBySkill;
  readCensusFile?: (path: string) => string;
  writeFile?: (path: string, data: string) => Promise<void>;
  now?: number;
}

async function writeEngagementFileAtomic(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, data, 'utf8');
    await renameWithRetry(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function readCensusFileDefault(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '{}';
  }
}

export async function runSkillEngagementAudit(deps: SkillEngagementDeps = {}): Promise<{
  touched: number;
  detail: { totalSkills: number; staleCount: number };
}> {
  const listSkills = deps.listSkills ?? defaultListSkills;
  const getLastSuccessfulRun = deps.getLastSuccessfulRun ?? defaultGetLastSuccessfulRun;
  const decisionStats = deps.decisionStats ?? decisionStatsBySkill;
  const readCensus = deps.readCensusFile ?? readCensusFileDefault;
  const writeDep = deps.writeFile ?? writeEngagementFileAtomic;

  const now = deps.now ?? Date.now();
  const ninetyDaysAgo = now - STALE_DAYS * DAY;

  // Load alert census for alertSent7d annotation
  let alertCensus: { families?: Array<{ ownerKind?: string; owner?: string; sent?: number }> } = {};
  try {
    const censusPath = join(paHome(), 'alert-census.json');
    const censusRaw = readCensus(censusPath);
    alertCensus = JSON.parse(censusRaw);
  } catch {
    // Absent/unparseable census ⇒ 0 for all skills
  }

  // Build alert count by skill
  const alertCountBySkill = new Map<string, number>();
  for (const family of alertCensus.families ?? []) {
    if (family.ownerKind === 'skill' && family.owner && typeof family.sent === 'number') {
      alertCountBySkill.set(family.owner, (alertCountBySkill.get(family.owner) ?? 0) + family.sent);
    }
  }

  // Get decision stats for 90d window
  const decisionsMap = decisionStats(new Date(ninetyDaysAgo).toISOString(), new Date(now).toISOString());

  const skills = await listSkills();
  const stale: Array<{
    skill: string;
    scheduled: boolean;
    lastSuccessAt: string | null;
    daysSinceLastSuccess: number | null;
    decisionRows90d: number;
    alertSent7d: number;
  }> = [];

  for (const skill of skills) {
    const lastSuccessMeta = await getLastSuccessfulRun(skill.name);
    const lastSuccessAt = lastSuccessMeta?.timestamp ?? null;
    const lastSuccessTimestamp = lastSuccessAt ? Date.parse(lastSuccessAt) : null;
    const daysSinceLastSuccess = lastSuccessTimestamp !== null ? Math.floor((now - lastSuccessTimestamp) / DAY) : null;

    const decisionRows90d = decisionsMap?.get(skill.name)?.total ?? 0;
    const alertSent7d = alertCountBySkill.get(skill.name) ?? 0;

    // Staleness rule: no success in 90d AND zero decision rows in that window
    const isStale = (lastSuccessTimestamp === null || (lastSuccessTimestamp !== null && now - lastSuccessTimestamp >= STALE_DAYS * DAY)) && decisionRows90d === 0;

    if (isStale) {
      stale.push({
        skill: skill.name,
        scheduled: !!skill.frontmatter.cron,
        lastSuccessAt,
        daysSinceLastSuccess,
        decisionRows90d,
        alertSent7d,
      });
    }
  }

  // Sort by skill name asc
  stale.sort((a, b) => a.skill.localeCompare(b.skill));

  const output = {
    generatedAt: new Date(now).toISOString(),
    windowDays: STALE_DAYS,
    totalSkills: skills.length,
    staleCount: stale.length,
    stale,
  };

  await writeDep(join(paHome(), 'skill-engagement.json'), JSON.stringify(output, null, 2));

  return {
    touched: stale.length,
    detail: { totalSkills: skills.length, staleCount: stale.length },
  };
}

/**
 * Monthly skill-engagement audit (AI-168, plans/2026-08-27-ai168-outcome-slos-SPEC.md):
 * joins listSkills + last-success run meta + decisions.sqlite rows + alert census;
 * writes ~/.pa/skill-engagement.json listing skills with ZERO user-facing engagement
 * for >=90 days. Report only — NEVER deletes, disables, or unschedules anything.
 * Non-destructive: no retention targets.
 */
export const skillEngagementAuditJob: MaintenanceJob = {
  name: 'skill-engagement-audit',
  host: 'pa',
  everyMs: 30 * DAY,
  description: 'Monthly skill-engagement audit (AI-168, plans/2026-08-27-ai168-outcome-slos-SPEC.md): joins listSkills + last-success run meta + decisions.sqlite rows + alert census; writes ~/.pa/skill-engagement.json listing skills with ZERO user-facing engagement for >=90 days. Report only — NEVER deletes, disables, or unschedules anything. Non-destructive: no retention targets.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    return runSkillEngagementAudit({
      listSkills: (ctx as any).listSkills,
      getLastSuccessfulRun: (ctx as any).getLastSuccessfulRun,
      decisionStats: (ctx as any).decisionStats,
      readCensusFile: (ctx as any).readCensusFile,
      writeFile: (ctx as any).writeFile,
      now: ctx.now,
    });
  },
};
