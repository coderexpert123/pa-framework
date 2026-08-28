import { randomBytes } from 'crypto';
import { unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { paHome } from '../../../paths.js';
import { buildAlertCensus, ALERT_CENSUS_FILE } from '../../alert-census.js';
import { notifyUser } from '../../notify.js';
import { renameWithRetry } from '../state.js';
import type { MaintenanceJob } from '../types.js';

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_NOTIFY_PER_DAY = 50;

export interface AlertCensusDeps {
  buildFn?: typeof buildAlertCensus;
  notifyFn?: typeof notifyUser;
  writeFn?: (path: string, data: string) => Promise<void>;
  /** Wall-clock ms for the census window; defaults to Date.now(). Threaded from
   *  MaintenanceJobContext.now by alertCensusJob.run so tests can drive it
   *  without a clock library (spec's runAlertCensus signature takes only
   *  `deps`, so `now` travels as a deps field rather than a second param). */
  now?: number;
}

async function writeCensusFileAtomic(path: string, data: string): Promise<void> {
  const tmpPath = `${path}.${process.pid.toString(36)}-${randomBytes(3).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, data, 'utf8');
    // Windows EPERM retry — mirrors maintenance/state.ts's writeLedgerAtomic
    // (AI-150): pa catchup and the bot can both touch ~/.pa concurrently.
    await renameWithRetry(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function runAlertCensus(deps: AlertCensusDeps = {}): Promise<{ touched: number; detail: Record<string, unknown> }> {
  const buildDep = deps.buildFn ?? buildAlertCensus;
  const notifyDep = deps.notifyFn ?? notifyUser;
  const writeDep = deps.writeFn ?? writeCensusFileAtomic;

  const census = await buildDep({ days: 7, now: new Date(deps.now ?? Date.now()) });

  await writeDep(join(paHome(), ALERT_CENSUS_FILE), JSON.stringify(census, null, 2));

  const threshold = Number(process.env.PA_ALERT_CENSUS_NOTIFY_PER_DAY) || DEFAULT_NOTIFY_PER_DAY;
  const perDay = census.totalSent / census.windowDays;
  if (perDay >= threshold) {
    const worst = census.families.slice(0, 3).map((f) => {
      const owner = f.owner ? `${f.ownerKind}:${f.owner}` : f.ownerKind;
      const status = f.ownerStatus?.status ?? 'unknown';
      return `- ${f.family}: ${f.sent} sent, owner=${owner}, status=${status}, class=${f.classification}`;
    }).join('\n');
    await notifyDep('Alert census (7d)', `${census.topLine}\n\n${worst}`, { dedupKey: 'alert-census', severity: 'info' });
  }

  return {
    touched: census.families.length,
    detail: {
      totalSent: census.totalSent,
      families: census.families.length,
      masked: census.maskedFailures.length,
    },
  };
}

/**
 * Daily alert census (2026-08-23, plans/2026-08-23-alerts-wave-SPEC.md) — STUB registered so
 * the registry compiles while the census work package lands. The real run(): builds the
 * 7-day census via lib/alert-census.ts, writes ~/.pa/alert-census.json atomically, and posts a
 * ONE-line census to pa-alerts only when sent/day ≥ the configured threshold (default 50).
 * Non-destructive: no retention targets.
 */
export const alertCensusJob: MaintenanceJob = {
  name: 'alert-census',
  host: 'pa',
  everyMs: DAY,
  description: 'Daily 7-day census of alerts sent/suppressed per family, joined with owner health; writes ~/.pa/alert-census.json for the self-improver and weekly digest.',
  destructive: false,
  shedWhenDegraded: true,
  targets: [],
  async run(ctx) {
    return runAlertCensus({ now: ctx.now });
  },
};
