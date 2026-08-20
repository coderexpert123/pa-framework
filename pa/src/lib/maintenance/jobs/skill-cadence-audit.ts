import { parseExpression } from 'cron-parser';
import { listSkills as defaultListSkills } from '../../../skills.js';
import { getLastSuccessfulRun as defaultGetLastSuccessfulRun, getFailureState as defaultGetFailureState } from '../../../logger.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import type { MaintenanceJob } from '../types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PARK_THRESHOLD = 5; // matches scheduler.PARK_AFTER_CONSECUTIVE_FAILURES

export const skillCadenceAuditJob: MaintenanceJob = {
  name: 'skill-cadence-audit',
  host: 'pa',
  everyMs: 1 * HOUR,
  description: 'Dead-man\'s-switch: detect scheduled skills that have not succeeded beyond max(2× interval, 26h) and alert.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    // Dedup handled by notifyUser via dedup key 'skill-cadence-audit'

    // Use injected functions from context if available (for testing), otherwise use defaults
    const listSkills = (ctx as any).listSkills || defaultListSkills;
    const getLastSuccessfulRun = (ctx as any).getLastSuccessfulRun || defaultGetLastSuccessfulRun;
    const getFailureState = (ctx as any).getFailureState || defaultGetFailureState;

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

        // Stale threshold: max(2× interval, 26h)
        const staleThresholdMs = Math.max(2 * intervalMs, 26 * HOUR);

        if (timeSinceSuccess > staleThresholdMs) {
          const hoursAgo = Math.round(timeSinceSuccess / HOUR);
          const intervalHours = Math.round(intervalMs / HOUR);
          const thresholdHours = Math.round(staleThresholdMs / HOUR);

          // Check if skill is parked (AI-098: parked after 5 consecutive failures)
          const failureState = await getFailureState(skill.name);
          const isParked = failureState.consecutiveFailures >= PARK_THRESHOLD;

          let alertMsg = `${skill.name}: last success ${hoursAgo}h ago (interval: ${intervalHours}h, threshold: ${thresholdHours}h)`;
          if (isParked) {
            alertMsg += ` [PARKED: ${failureState.consecutiveFailures} consecutive failures]`;
          }
          alerts.push(alertMsg);
        }
      } catch { /* skip invalid cron */ }
    }

    if (alerts.length > 0) {
      const msg = alerts.join('\n');
      log('warn', 'maintenance', `${alerts.length} skill(s) missed cadence threshold`, { skills: alerts });
      await notifyUser(
        'Skill Cadence Audit — Dead Man\'s Switch Alert',
        msg,
        { dedupKey: 'skill-cadence-audit', severity: 'warn', runbook: 'runbooks/missed-alert-class.md' },
      ).catch(() => {});
    }

    return { touched: alerts.length, detail: { skills: alerts } };
  },
};
