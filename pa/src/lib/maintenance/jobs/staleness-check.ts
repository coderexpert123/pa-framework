import { parseExpression } from 'cron-parser';
import { listSkills } from '../../../skills.js';
import { getLastSuccessfulRun } from '../../../logger.js';
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
        // Skip sub-hourly skills (e.g. reminders at * * * * *) — their 2x threshold
        // would be only 2 minutes, firing on every maintenance pass.
        if (intervalMs < 60 * 60 * 1000) continue;
        const timeSinceSuccess = now - new Date(lastSuccess.timestamp).getTime();
        if (timeSinceSuccess > 2 * intervalMs) {
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
        { dedupKey: 'staleness', severity: 'warn' },
      ).catch(() => {});
    }

    return { touched: alerts.length, detail: { skills: alerts } };
  },
};
