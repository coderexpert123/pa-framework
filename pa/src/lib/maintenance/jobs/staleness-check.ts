import { createHash } from 'crypto';
import { parseExpression } from 'cron-parser';
import { listSkills as defaultListSkills } from '../../../skills.js';
import { getLastSuccessfulRun as defaultGetLastSuccessfulRun, getFailureState as defaultGetFailureState } from '../../../logger.js';
import { isTimePinnedCron, PARK_AFTER_CONSECUTIVE_FAILURES } from '../../../scheduler.js';
import { notifyUser } from '../../notify.js';
import { log } from '../../log.js';
import type { MaintenanceHost, MaintenanceJob, MaintenanceOverrides } from '../types.js';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { randomBytes } from 'crypto';
import { basename, join } from 'path';
import { paHome } from '../../../paths.js';
import { formatArchiveStamp } from '../../archive-files.js';
import { STALL_RECORDS_ARCHIVE_SUFFIX, stallRecordsPath } from '../../stall.js';
import { readLedger as defaultReadLedger, type MaintenanceLedger } from '../state.js';

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

/** A host writes a ledger row for every declared job on every pass, skips
 *  included, so a row older than this means that host's pass is not running
 *  (process down or pass wedged). Flat on purpose: a multiple of each job's own
 *  cadence would leave long-cadence jobs blind for days (2026-09-16). */
export const LEDGER_FRESHNESS_STALE_MS = 15 * MINUTE;

export interface StaleLedgerJob {
  name: string;
  host: MaintenanceHost;
  ageMs: number;
}

/** PURE. Jobs disabled by override and jobs with no ledger row are never stale. */
export function findStaleLedgerJobs(
  ledger: MaintenanceLedger,
  jobs: readonly MaintenanceJob[],
  overrides: MaintenanceOverrides,
  nowMs: number,
): StaleLedgerJob[] {
  const stale: StaleLedgerJob[] = [];
  for (const job of jobs) {
    if (overrides[job.name]?.enabled === false) continue;
    const row = ledger.jobs[job.name];
    if (!row) continue;
    const touched = [row.lastAttemptAt, row.lastSkipAt, row.lastRunAt]
      .map((iso) => (iso ? new Date(iso).getTime() : NaN))
      .filter((ms) => Number.isFinite(ms));
    if (touched.length === 0) continue;
    const ageMs = nowMs - Math.max(...touched);
    if (ageMs > LEDGER_FRESHNESS_STALE_MS) stale.push({ name: job.name, host: job.host, ageMs });
  }
  return stale.sort((a, b) => (a.host === b.host ? a.name.localeCompare(b.name) : a.host.localeCompare(b.host)));
}

/** Transition-keyed like stalenessDedupKey: changes only when the stale SET changes. */
export function ledgerFreshnessDedupKey(stale: ReadonlyArray<{ name: string; host: string }>): string {
  return 'maintenance-freshness:' + createHash('sha1').update(stale.map((s) => `${s.host}/${s.name}`).sort().join('\n')).digest('hex').slice(0, 16);
}

/** Stable body (no ages) so a persisting condition escalates its dedup window. */
export function formatLedgerFreshnessBody(stale: ReadonlyArray<{ name: string; host: string }>): string {
  const hosts = [...new Set(stale.map((s) => s.host))].sort();
  const lines = hosts.map((host) => `${host}: ${stale.filter((s) => s.host === host).map((s) => s.name).sort().join(', ')}`);
  return `No attempt or skip recorded for over 15 min:\n${lines.join('\n')}\nThat host's maintenance pass is not running: the process is down or its pass is wedged.`;
}

export interface StallDrainResult {
  drained: number;
  unparseable: number;
  archivedTo: string | null;
}

/** Moves ~/.pa/stall-records.jsonl into ~/.pa/archive/ (pruned by archive-prune after
 *  90 days) and logs one error line per record with a ref-id. A rename that fails
 *  because a writer holds the file open is retried on the next run. Never throws. */
export function drainStallRecords(nowMs: number = Date.now()): StallDrainResult {
  const source = stallRecordsPath();
  try {
    if (!existsSync(source) || statSync(source).size === 0) return { drained: 0, unparseable: 0, archivedTo: null };
    const archiveDir = join(paHome(), 'archive');
    mkdirSync(archiveDir, { recursive: true });
    const target = join(archiveDir, `${formatArchiveStamp(new Date(nowMs))}-${randomBytes(2).toString('hex')}${STALL_RECORDS_ARCHIVE_SUFFIX}`);
    renameSync(source, target);
    let drained = 0;
    let unparseable = 0;
    for (const line of readFileSync(target, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        unparseable++;
        continue;
      }
      drained++;
      const refId = typeof record.refId === 'string' ? record.refId : `s-${randomBytes(6).toString('hex')}`;
      const message = record.host === 'launcher'
        ? `catchup launcher restarted a stalled loop: ${String(record.cause ?? 'unknown cause')}`
        : `store stall: ${String(record.store ?? 'unknown')}${record.target ? ` (${String(record.target)})` : ''} in ${String(record.host ?? 'unknown host')}`;
      log('error', 'stall', message, { ...record, refId, archivedTo: basename(target) });
    }
    if (unparseable > 0) log('warn', 'stall', `${unparseable} unparseable stall record line(s)`, { archivedTo: basename(target) });
    return { drained, unparseable, archivedTo: target };
  } catch {
    return { drained: 0, unparseable: 0, archivedTo: null };
  }
}

export const stalenessCheckJob: MaintenanceJob = {
  name: 'staleness-check',
  host: 'pa',
  everyMs: 1 * MINUTE,
  description: "THE dead-man's switch for scheduled skills: alerts when a skill's last success is older than max(2x its cron interval, 30 min), skipping parked skills and widening for cost_tier: off_peak deferrals. (skill-cadence-audit retired 2026-08-23 as a strictly-later duplicate.) Also pages Maintenance ledger stale when a declared job of either host has no ledger attempt or skip for 15 min, and drains stall-records.jsonl into the archive and the log (2026-09-16).",
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

    // Phase 2 — ledger freshness (D4, 2026-09-16). Its real target is the bot
    // host; for pa-host rows it is blind to a wedged pa maintenance lane (this
    // job runs on that lane) — the per-minute launcher covers that case.
    const readLedgerFn: () => Promise<MaintenanceLedger> = (ctx as any).readLedger || defaultReadLedger;
    const declaredJobs: readonly MaintenanceJob[] =
      (ctx as any).declaredJobs || (await import('../registry.js')).MAINTENANCE_JOBS;
    let overrides: MaintenanceOverrides = (ctx as any).maintenanceOverrides ?? {};
    if (!(ctx as any).maintenanceOverrides) {
      try {
        overrides = ((await (await import('../../../config.js')).loadConfig()).maintenance ?? {}) as MaintenanceOverrides;
      } catch {
        overrides = {};
      }
    }
    const staleJobs = findStaleLedgerJobs(await readLedgerFn(), declaredJobs, overrides, now);
    if (staleJobs.length > 0) {
      log('warn', 'maintenance', `${staleJobs.length} declared job(s) with no ledger attempt or skip for 15 min (ledger freshness)`, {
        jobs: staleJobs.map((s) => ({ name: s.name, host: s.host, ageMin: Math.round(s.ageMs / MINUTE) })),
      });
      await notifyUser('Maintenance ledger stale', formatLedgerFreshnessBody(staleJobs), {
        dedupKey: ledgerFreshnessDedupKey(staleJobs),
        severity: 'error',
      }).catch(() => {});
    }

    // Phase 3 — stall-evidence drain (C5/C11/C12, 2026-09-16).
    const drain = drainStallRecords(now);

    return {
      touched: alerts.length + staleJobs.length + drain.drained,
      detail: { skills: alerts, staleJobs: staleJobs.map((s) => `${s.host}/${s.name}`), stallRecordsDrained: drain.drained },
    };
  },
};
