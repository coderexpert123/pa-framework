import { createHash } from 'crypto';
import { parseExpression } from 'cron-parser';
import { listSkills as defaultListSkills } from '../../../skills.js';
import { getLastSuccessfulRun as defaultGetLastSuccessfulRun, getFailureState as defaultGetFailureState } from '../../../logger.js';
import { isTimePinnedCron, PARK_AFTER_CONSECUTIVE_FAILURES } from '../../../scheduler.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import type { MaintenanceJob } from '../types.js';

const MINUTE = 60_000;
/** The z.ai peak billing window is exactly 4h (Mon-Fri 06:00-10:00 UTC,
 *  scheduler.ts:28-32); cost_tier: off_peak periodic skills defer during it. */
const PEAK_WINDOW_MS = 4 * 3_600_000;

/** Transition-keyed dedup: the alert fires on a CHANGE of the stale-skill SET,
 *  not on every tick's hours-ago number. Exported so the test can assert
 *  stability/change directly without going through notifyUser (2026-08-23,
 *  the alerts-wave spec). */
export function stalenessDedupKey(names: string[]): string {
  return 'staleness:' + createHash('sha1').update([...names].sort().join('\n')).digest('hex').slice(0, 16);
}

export const stalenessCheckJob: MaintenanceJob = {
  name: 'staleness-check',
  host: 'pa',
  everyMs: 1 * MINUTE,
  description: "THE dead-man's switch for scheduled skills: alerts when a skill's last success is older than max(2x its cron interval, 30 min), skipping parked skills and widening for cost_tier: off_peak deferrals. (skill-cadence-audit retired 2026-08-23 as a strictly-later duplicate.)",
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    // Dedup handled by notifyUser via a transition-keyed dedup key (stalenessDedupKey)

    // Use injected functions from context if available (for testing), otherwise use defaults
    const listSkills = (ctx as any).listSkills || defaultListSkills;
    const getLastSuccessfulRun = (ctx as any).getLastSuccessfulRun || defaultGetLastSuccessfulRun;
    const getFailureState = (ctx as any).getFailureState || defaultGetFailureState;

    const skills = await listSkills();
    const now = ctx.now;
    const alerts: string[] = [];
    const alertNames: string[] = [];

    for (const skill of skills) {
      if (!skill.frontmatter.cron) continue;
      const lastSuccess = await getLastSuccessfulRun(skill.name);
      if (!lastSuccess) continue; // never succeeded — separate concern

      // Parked skills already page separately (catchup.ts's "Skill parked after
      // repeated failures"); reporting them here too is a third copy of one
      // condition (review §3.3).
      const fs = await getFailureState(skill.name);
      if (fs.consecutiveFailures >= PARK_AFTER_CONSECUTIVE_FAILURES) continue;

      // cost_tier: off_peak periodic (non-time-pinned) skills are deliberately
      // deferred by partitionOverdueByCostTier during the 4h z.ai peak window,
      // so their staleness threshold widens by that same 4h — otherwise a
      // healthy off_peak skill is reported stale on every deferral
      // (rate-limit-retrospective, review §5.5). Time-pinned crons are never
      // deferred for cost_tier (scheduler.ts partitionOverdueByCostTier), so
      // they get no widening.
      const deferredByCostTier = skill.frontmatter.cost_tier === 'off_peak' && !isTimePinnedCron(skill.frontmatter.cron);

      try {
        const interval = parseExpression(skill.frontmatter.cron, { tz: 'UTC' });
        const next1 = interval.next().toDate();
        const next2 = interval.next().toDate();
        const intervalMs = next2.getTime() - next1.getTime();
        const timeSinceSuccess = now - new Date(lastSuccess.timestamp).getTime();
        // Applied uniformly: stale when >2x interval (+4h if cost_tier-deferred)
        // AND at least 30 minutes (+4h if cost_tier-deferred) (P2-16, widened 2026-08-23)
        const minMs = deferredByCostTier ? 30 * 60_000 + PEAK_WINDOW_MS : 30 * 60_000;
        if (timeSinceSuccess > 2 * intervalMs + (deferredByCostTier ? PEAK_WINDOW_MS : 0) && timeSinceSuccess > minMs) {
          const hoursAgo = Math.round(timeSinceSuccess / 3600000);
          alerts.push(`${skill.name}: last success ${hoursAgo}h ago (interval: ${Math.round(intervalMs / 3600000)}h)`);
          alertNames.push(skill.name);
        }
      } catch { /* skip invalid cron */ }
    }

    if (alerts.length > 0) {
      const msg = alerts.join('\n');
      log('warn', 'maintenance', `${alerts.length} stale skill(s) detected (dead-man's switch)`, { skills: alerts });
      await notifyUser(
        'Stale Skills Detected',
        msg,
        { dedupKey: stalenessDedupKey(alertNames), severity: 'warn', runbook: 'runbooks/missed-alert-class.md' },
      ).catch(() => {});
    }

    return { touched: alerts.length, detail: { skills: alerts } };
  },
};
