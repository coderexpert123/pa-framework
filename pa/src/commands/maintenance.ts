import { MAINTENANCE_JOBS, findJob } from '../lib/maintenance/registry.js';
import { previewJob, runDueJobs } from '../lib/maintenance/runner.js';
import { readLedger, maintenanceStatePath } from '../lib/maintenance/state.js';
import type { MaintenanceJobState } from '../lib/maintenance/state.js';
import { loadConfig } from '../config.js';

/** Humanise a millisecond duration, picking the largest unit that divides it
 *  evenly (d > h > m > s > ms); falls back to a decimal in the largest unit
 *  that fits when nothing divides evenly. */
function humaniseMs(ms: number): string {
  const units: Array<[string, number]> = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000], ['ms', 1]];
  for (const [suffix, unitMs] of units) {
    if (ms >= unitMs && ms % unitMs === 0) return `${ms / unitMs}${suffix}`;
  }
  for (const [suffix, unitMs] of units) {
    if (ms >= unitMs) return `${(ms / unitMs).toFixed(1)}${suffix}`;
  }
  return `${ms}ms`;
}

function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const diff = nowMs - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ${suffix}`;
  return `${Math.round(abs / 86_400_000)}d ${suffix}`;
}

async function listSubcommand(): Promise<void> {
  let maintenanceOverrides: Record<string, { enabled?: boolean; everyMs?: number }> | undefined;
  try {
    const config = await loadConfig();
    maintenanceOverrides = config.maintenance;
  } catch (err: any) {
    console.warn(`[maintenance list] Could not load config.yaml (${err.message}); showing declared cadences with no override annotation.`);
  }

  const jobs = [...MAINTENANCE_JOBS].sort((a, b) =>
    a.host === b.host ? a.name.localeCompare(b.name) : a.host.localeCompare(b.host));

  for (const job of jobs) {
    const declaredMs = typeof job.everyMs === 'function' ? job.everyMs() : job.everyMs;
    const override = maintenanceOverrides?.[job.name];
    const resolvedMs = override?.everyMs ?? declaredMs;
    const enabled = override?.enabled !== false;

    console.log(`\n${job.name}  [${job.host}]`);
    const cadenceNote = override?.everyMs !== undefined ? ` (overridden from ${humaniseMs(declaredMs)})` : '';
    console.log(`  cadence: ${humaniseMs(resolvedMs)}${cadenceNote}`);
    console.log(`  enabled: ${enabled}`);
    console.log(`  destructive: ${job.destructive}`);
    console.log(`  shedWhenDegraded: ${job.shedWhenDegraded}`);
    console.log(`  ${job.description}`);

    if (job.targets.length === 0) {
      console.log('  targets: none (non-destructive)');
      continue;
    }

    for (const target of job.targets) {
      let resolvedPath: string;
      try {
        resolvedPath = target.resolve();
      } catch (err: any) {
        resolvedPath = `<error resolving target: ${err.message}>`;
      }
      console.log(`    - path: ${resolvedPath}`);
      console.log(`      match: ${target.match.source}`);
      console.log(`      maxAge: ${humaniseMs(target.maxAgeMs)}`);
      console.log(`      action: ${target.action}`);
      console.log(`      ownership: ${target.ownership}`);
      console.log(`      evidence: ${target.evidence}`);
      if (target.note) console.log(`      note: ${target.note}`);
    }
  }
}

function printJobStatus(name: string, host: string, state: MaintenanceJobState | undefined): void {
  console.log(`\n${name}  [${host}]`);
  if (!state) {
    console.log('  never run');
    return;
  }
  console.log(`  last run: ${state.lastRunAt ? `${state.lastRunAt} (${relativeTime(state.lastRunAt)})` : 'never'}`);
  console.log(`  last outcome: ${state.lastOutcome ?? 'n/a'}`);
  console.log(`  last touched: ${state.lastTouched ?? 'n/a'}`);
  if (state.lastSkipAt) {
    console.log(`  last skip: ${state.lastSkipAt} (${relativeTime(state.lastSkipAt)}) — reason: ${state.lastSkipReason ?? 'unknown'}`);
  }
  if (state.lastError) {
    console.log(`  last error: ${state.lastError}`);
  }
  console.log(`  consecutive failures: ${state.consecutiveFailures}`);
  console.log(`  consecutive skips: ${state.consecutiveSkips}`);
}

async function statusSubcommand(): Promise<void> {
  const ledger = await readLedger();

  for (const job of MAINTENANCE_JOBS) {
    printJobStatus(job.name, job.host, ledger.jobs[job.name]);
  }

  const known = new Set(MAINTENANCE_JOBS.map((j) => j.name));
  const foreign = Object.keys(ledger.jobs).filter((n) => !known.has(n)).sort();
  if (foreign.length > 0) {
    console.log("\n--- jobs declared outside this registry (host: 'bot'; see projects/telegram-bot/src/maintenance-jobs.ts) ---");
    for (const name of foreign) {
      printJobStatus(name, 'bot', ledger.jobs[name]);
    }
  }

  console.log(`\nLedger: ${maintenanceStatePath()}`);
}

async function runSubcommand(args: string[]): Promise<void> {
  const jobName = args[0];
  const dryRun = args.includes('--dry-run');
  const job = findJob(jobName);

  if (!job) {
    console.error(`Unknown maintenance job: '${jobName ?? ''}'`);
    console.error('Valid jobs:');
    for (const j of MAINTENANCE_JOBS) console.error(`  ${j.name}  [${j.host}]`);
    console.error("  (host: 'bot' jobs are declared inside the Telegram bot process and run there; see `pa maintenance status` for their ledger rows.)");
    process.exitCode = 2;
    return;
  }

  if (job.host === 'bot') {
    console.log(`Note: '${job.name}' is a host: 'bot' job — it normally runs inside the Telegram bot process, not via this CLI.`);
  }

  if (dryRun) {
    const previews = await previewJob(job);
    for (const preview of previews) {
      const verb = preview.target.action === 'delete' ? 'delete' : 'archive';
      console.log(`\nTarget: ${preview.resolvedPath} (exists: ${preview.exists})`);
      if (preview.note) console.log(`  note: ${preview.note}`);
      for (const candidate of preview.candidates.slice(0, 20)) {
        console.log(`  [dry-run] would ${verb}: ${candidate}`);
      }
      if (preview.candidates.length > 20) {
        console.log(`  … and ${preview.candidates.length - 20} more`);
      }
      console.log(`  summary: ${preview.candidates.length} candidate(s)`);
    }
    console.log('\nDry run complete. Re-run without --dry-run to actually run the job.');
    return;
  }

  let maintenanceOverrides: Record<string, { enabled?: boolean; everyMs?: number }> | undefined;
  try {
    const config = await loadConfig();
    maintenanceOverrides = config.maintenance;
  } catch {
    // No config — run with declared defaults.
  }

  const records = await runDueJobs(job.host, [job], {
    overrides: maintenanceOverrides,
    onlyJob: job.name,
    force: true,
  });

  const record = records[0];
  if (!record) {
    console.error(`Job '${job.name}' did not produce a run record.`);
    process.exitCode = 1;
    return;
  }

  console.log(`${record.name}: ${record.outcome}`);
  if (record.touched !== undefined) console.log(`  touched: ${record.touched}`);
  if (record.error) console.log(`  error: ${record.error}`);
  if (record.detail) console.log(`  detail: ${JSON.stringify(record.detail)}`);
}

export async function maintenanceCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  switch (sub) {
    case 'list':
      await listSubcommand();
      break;
    case 'status':
      await statusSubcommand();
      break;
    case 'run':
      await runSubcommand(args.slice(1));
      break;
    default:
      console.log('Usage: pa maintenance <list|status|run <job> [--dry-run]>');
  }
}
