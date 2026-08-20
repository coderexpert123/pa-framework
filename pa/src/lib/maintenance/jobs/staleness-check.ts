import { parseExpression } from 'cron-parser';
import { listSkills as defaultListSkills } from '../../../skills.js';
import { getLastSuccessfulRun as defaultGetLastSuccessfulRun } from '../../../logger.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import type { MaintenanceJob } from '../types.js';

const MINUTE = 60_000;

export const stalenessCheckJob: MaintenanceJob = {
  name: 'staleness-check',
  host: 'pa',
  everyMs: 1 * MINUTE,
  description: "Detect skills whose last successful run is stale relative to their cron interval (>2x) and alert.",
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    // Dedup handled by notifyUser via dedup key 'staleness'

    // Use injected functions from context if available (for testing), otherwise use defaults
    const listSkills = (ctx as any).listSkills || defaultListSkills;
    const getLastSuccessfulRun = (ctx as any).getLastSuccessfulRun || defaultGetLastSuccessfulRun;

    const skills = await listSkills();
    const now = ctx.now;
    const alerts: string[] = [];

    for (const skill of skills) {
      if (!skill.frontmatter.cron) continue;
      const lastSuccess = await getLastSuccessfulRun(skill.name);
      if (!lastSuccess) continue; // never succeeded — separate concern

      try {
        const interval = parseExpression(skill.frontmatter.cron, { tz: 'UTC' });
        const next1 = interval.next().toDate();
        const next2 = interval.next().toDate();
        const intervalMs = next2.getTime() - next1.getTime();
        const timeSinceSuccess = now - new Date(lastSuccess.timestamp).getTime();
        // Applied uniformly: stale when >2x interval AND at least 30 minutes (P2-16)
        if (timeSinceSuccess > 2 * intervalMs && timeSinceSuccess > 30 * 60 * 1000) {
          const hoursAgo = Math.round(timeSinceSuccess / 3600000);
          alerts.push(`${skill.name}: last success ${hoursAgo}h ago (interval: ${Math.round(intervalMs / 3600000)}h)`);
        }
      } catch { /* skip invalid cron */ }
    }

    if (alerts.length > 0) {
      const msg = alerts.join('\n');
      log('warn', 'maintenance', `${alerts.length} stale skill(s) detected`, { skills: alerts });
      await notifyUser(
        'Stale Skills Detected',
        msg,
        { dedupKey: 'staleness', severity: 'warn', runbook: 'runbooks/missed-alert-class.md' },
      ).catch(() => {});
    }

    return { touched: alerts.length, detail: { skills: alerts } };
  },
};
